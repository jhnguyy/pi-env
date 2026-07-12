import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Either, Schema } from "effect";
import { decodeSettingsBlockSync } from "../_shared/settings";
import { slugify } from "../_shared/slug";
import { extractChangelogSection, isPiPackageName, packageManagerName, packageNamesEither, writeInstallCommand, writeReport } from "./artifacts";
import { DEFAULT_REPO, PI_PACKAGE, PI_UPDATE_DOC_PATHS, type PiUpdateOptions, type PiUpdatePrep } from "./contract";
import { PiUpdateError, PiUpdatePhase } from "./errors";

type Exec = ExtensionAPI["exec"];

const PiUpdateSettingsSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
});

export function isPiUpdateEnabled(cwd = process.cwd()): boolean {
  return decodeSettingsBlockSync("piUpdate", PiUpdateSettingsSchema, cwd).enabled === true;
}

function runEffect(exec: Exec, command: string, args: string[], options: { cwd?: string; timeout?: number } = {}): Effect.Effect<ExecResult, PiUpdateError> {
  return Effect.flatMap(
    Effect.tryPromise({
      try: (signal) => exec(command, args, { timeout: options.timeout ?? 120000, cwd: options.cwd, signal }),
      catch: (cause) => new PiUpdateError({ phase: PiUpdatePhase.Command, detail: [command, ...args].join(" "), cause }),
    }),
    (result) => {
      if (result.code === 0) return Effect.succeed(result);
      const rendered = [command, ...args].join(" ");
      return Effect.fail(new PiUpdateError({ phase: PiUpdatePhase.Command, detail: `${rendered} exited ${result.code}: ${result.stderr || result.stdout}` }));
    },
  );
}

function resolveRepoEffect(exec: Exec, requestedRepo?: string): Effect.Effect<string, PiUpdateError> {
  return Effect.gen(function* () {
    const repo = requestedRepo ?? process.env.PI_ENV_REPO ?? DEFAULT_REPO;
    if (existsSync(join(repo, ".git"))) return repo;
    const result = yield* runEffect(exec, "git", ["rev-parse", "--show-toplevel"]);
    const fallback = result.stdout.trim();
    if (fallback && existsSync(join(fallback, ".git"))) return fallback;
    return yield* new PiUpdateError({ phase: PiUpdatePhase.ResolveRepo, detail: "repo not found; pass --repo PATH" });
  });
}

function resolveVersionEffect(exec: Exec, version: string): Effect.Effect<string, PiUpdateError> {
  if (version !== "latest") return Effect.succeed(version);
  return Effect.map(runEffect(exec, "npm", ["view", PI_PACKAGE, "version"]), (result) => result.stdout.trim());
}

function prepareWorktreeEffect(exec: Exec, repo: string, version: string, requestedWorktree?: string): Effect.Effect<{ branch: string; worktree: string }, PiUpdateError> {
  return Effect.gen(function* () {
    const branch = `chore/update-pi-${version}`;
    const worktree = requestedWorktree ?? join(tmpdir(), `pi-env-${slugify(branch, { fallback: "update" })}`);

    const currentBranch = (yield* runEffect(exec, "git", ["branch", "--show-current"], { cwd: repo })).stdout.trim();
    if (currentBranch !== "main") {
      return yield* new PiUpdateError({ phase: PiUpdatePhase.Worktree, detail: `base repo must be on main, found ${currentBranch}` });
    }

    const status = (yield* runEffect(exec, "git", ["status", "--porcelain=v1"], { cwd: repo })).stdout.trim();
    if (status) return yield* new PiUpdateError({ phase: PiUpdatePhase.Worktree, detail: "base repo has uncommitted changes" });

    yield* runEffect(exec, "git", ["fetch", "origin"], { cwd: repo });
    yield* runEffect(exec, "git", ["merge", "--ff-only", "origin/main"], { cwd: repo });

    const worktrees = (yield* runEffect(exec, "git", ["worktree", "list", "--porcelain"], { cwd: repo })).stdout;
    if (worktrees.split(/\r?\n/).includes(`worktree ${worktree}`)) return { branch, worktree };

    const branchExists = (yield* Effect.tryPromise({
      try: (signal) => exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo, timeout: 30000, signal }),
      catch: (cause) => new PiUpdateError({ phase: PiUpdatePhase.Worktree, detail: `checking ${branch}`, cause }),
    })).code === 0;
    yield* runEffect(exec, "git", branchExists ? ["worktree", "add", worktree, branch] : ["worktree", "add", worktree, "-b", branch], { cwd: repo });
    return { branch, worktree };
  });
}

function fetchReleaseArtifactsEffect(exec: Exec, prep: PiUpdatePrep): Effect.Effect<void, PiUpdateError> {
  return Effect.gen(function* () {
    const artifactDir = join(prep.worktree, ".pi-update", prep.version);
    const packageDir = join(artifactDir, "package");
    yield* Effect.try({
      try: () => mkdirSync(packageDir, { recursive: true }),
      catch: (cause) => new PiUpdateError({ phase: PiUpdatePhase.Artifacts, detail: `creating ${packageDir}`, cause }),
    });

    const temp = join(tmpdir(), `pi-update-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          mkdirSync(temp, { recursive: true });
          return temp;
        },
        catch: (cause) => new PiUpdateError({ phase: PiUpdatePhase.Artifacts, detail: `creating ${temp}`, cause }),
      }),
      (temp) =>
        Effect.gen(function* () {
          yield* runEffect(exec, "npm", ["pack", `${PI_PACKAGE}@${prep.version}`, "--silent"], { cwd: temp });
          const tarball = readdirSync(temp).find((entry) => entry.endsWith(".tgz"));
          if (!tarball) return yield* new PiUpdateError({ phase: PiUpdatePhase.Artifacts, detail: "npm pack did not produce a tarball" });
          yield* runEffect(exec, "tar", ["-xzf", join(temp, tarball), ...PI_UPDATE_DOC_PATHS], { cwd: temp });
          yield* Effect.try({
            try: () => cpSync(join(temp, "package"), packageDir, { recursive: true }),
            catch: (cause) => new PiUpdateError({ phase: PiUpdatePhase.Artifacts, detail: `copying package docs to ${packageDir}`, cause }),
          });
        }),
      (temp) =>
        Effect.sync(() => {
          try {
            rmSync(temp, { recursive: true, force: true });
          } catch (cause) {
            console.warn(`pi-update warning: failed to remove temporary release artifact directory ${temp}: ${cause instanceof Error ? cause.message : String(cause)}`);
          }
        }),
    );

    const changelogPath = join(packageDir, "CHANGELOG.md");
    if (!existsSync(changelogPath)) return yield* new PiUpdateError({ phase: PiUpdatePhase.Artifacts, detail: "package changelog not found" });
    const section = extractChangelogSection(readFileSync(changelogPath, "utf8"), prep.version);
    if (!section.trim()) return yield* new PiUpdateError({ phase: PiUpdatePhase.Artifacts, detail: `changelog section for ${prep.version} not found` });

    const packageJsonPath = join(prep.worktree, "package.json");
    const names = packageNamesEither(packageJsonPath, isPiPackageName);
    if (Either.isLeft(names)) return yield* names.left;
    const packageManager = packageManagerName(packageJsonPath);

    yield* Effect.try({
      try: () => {
        writeFileSync(prep.changelog, section);
        writeInstallCommand(prep.installCommand, names.right, prep.version, packageManager);
        writeReport(prep.report, prep);
      },
      catch: (cause) => new PiUpdateError({ phase: PiUpdatePhase.Artifacts, detail: "writing prepared artifacts", cause }),
    });
  });
}

export function preparePiUpdateEffect(exec: Exec, options: PiUpdateOptions): Effect.Effect<PiUpdatePrep, PiUpdateError> {
  return Effect.gen(function* () {
    const repo = yield* resolveRepoEffect(exec, options.repo);
    const version = yield* resolveVersionEffect(exec, options.version);
    const { branch, worktree } = yield* prepareWorktreeEffect(exec, repo, version, options.worktreeDir);
    const artifactDir = join(worktree, ".pi-update", version);
    const prep: PiUpdatePrep = {
      version,
      branch,
      worktree,
      report: join(artifactDir, "report.md"),
      changelog: join(artifactDir, "changelog-section.md"),
      installCommand: join(artifactDir, "install-command.sh"),
    };
    yield* fetchReleaseArtifactsEffect(exec, prep);
    return prep;
  });
}

export function preparePiUpdate(exec: Exec, options: PiUpdateOptions): Promise<PiUpdatePrep> {
  return Effect.runPromise(preparePiUpdateEffect(exec, options));
}
