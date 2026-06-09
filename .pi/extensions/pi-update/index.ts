import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExecResult, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readSettingsBlock } from "../_shared/settings";
import { slugify } from "../_shared/slug";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_PACKAGE_PREFIX = "@earendil-works/pi-";
const DEFAULT_REPO = "/mnt/tank/code/pi-env";
const DOC_PATHS = [
  "package/CHANGELOG.md",
  "package/README.md",
  "package/docs/extensions.md",
  "package/docs/sdk.md",
  "package/docs/usage.md",
  "package/docs/settings.md",
];

export interface PiUpdateOptions {
  version: string;
  repo?: string;
  worktreeDir?: string;
}

export interface PiUpdatePrep {
  version: string;
  branch: string;
  worktree: string;
  report: string;
  changelog: string;
  installCommand: string;
}

type Exec = ExtensionAPI["exec"];

export function isPiUpdateEnabled(cwd = process.cwd()): boolean {
  return readSettingsBlock("piUpdate", cwd).enabled === true;
}

export function parseArgs(args: string): PiUpdateOptions {
  const tokens = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
  let version = "latest";
  let repo: string | undefined;
  let worktreeDir: string | undefined;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--repo") {
      repo = tokens[++i];
    } else if (token === "--worktree-dir") {
      worktreeDir = tokens[++i];
    } else if (token === "latest" || !token.startsWith("--")) {
      version = token;
    }
  }

  return { version, repo, worktreeDir };
}

async function run(exec: Exec, command: string, args: string[], options: { cwd?: string; timeout?: number } = {}): Promise<ExecResult> {
  const result = await exec(command, args, { timeout: options.timeout ?? 120000, cwd: options.cwd });
  if (result.code !== 0) {
    const rendered = [command, ...args].join(" ");
    throw new Error(`${rendered} failed (${result.code}): ${result.stderr || result.stdout}`);
  }
  return result;
}

async function resolveRepo(exec: Exec, requestedRepo?: string): Promise<string> {
  const repo = requestedRepo ?? process.env.PI_ENV_REPO ?? DEFAULT_REPO;
  if (existsSync(join(repo, ".git"))) return repo;
  const result = await run(exec, "git", ["rev-parse", "--show-toplevel"]);
  const fallback = result.stdout.trim();
  if (fallback && existsSync(join(fallback, ".git"))) return fallback;
  throw new Error("repo not found; pass --repo PATH");
}

async function resolveVersion(exec: Exec, version: string): Promise<string> {
  if (version !== "latest") return version;
  return (await run(exec, "npm", ["view", PI_PACKAGE, "version"])).stdout.trim();
}

async function prepareWorktree(exec: Exec, repo: string, version: string, requestedWorktree?: string): Promise<{ branch: string; worktree: string }> {
  const branch = `chore/update-pi-${version}`;
  const worktree = requestedWorktree ?? join(tmpdir(), `pi-env-${slugify(branch, { fallback: "update" })}`);

  const currentBranch = (await run(exec, "git", ["branch", "--show-current"], { cwd: repo })).stdout.trim();
  if (currentBranch !== "main") throw new Error(`base repo must be on main, found ${currentBranch}`);

  const status = (await run(exec, "git", ["status", "--porcelain=v1"], { cwd: repo })).stdout.trim();
  if (status) throw new Error("base repo has uncommitted changes");

  await run(exec, "git", ["fetch", "origin"], { cwd: repo });
  await run(exec, "git", ["merge", "--ff-only", "origin/main"], { cwd: repo });

  const worktrees = (await run(exec, "git", ["worktree", "list", "--porcelain"], { cwd: repo })).stdout;
  if (worktrees.split(/\r?\n/).includes(`worktree ${worktree}`)) return { branch, worktree };

  const branchExists = (await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo, timeout: 30000 })).code === 0;
  await run(exec, "git", branchExists ? ["worktree", "add", worktree, branch] : ["worktree", "add", worktree, "-b", branch], { cwd: repo });
  return { branch, worktree };
}

export function extractChangelogSection(changelogText: string, version: string): string {
  const lines = changelogText.split(/\r?\n/);
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex((line) => new RegExp(`^## \\[?${escapedVersion}\\]?`).test(line));
  if (start < 0) return "";
  const rest = lines.slice(start);
  const next = rest.findIndex((line, index) => index > 0 && line.startsWith("## "));
  return `${(next < 0 ? rest : rest.slice(0, next)).join("\n").trim()}\n`;
}

export function isPiPackageName(name: string): boolean {
  return name.startsWith(PI_PACKAGE_PREFIX);
}

export function packageNames(packageJsonPath: string, targetPackage: (name: string) => boolean): string[] {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, Record<string, string> | undefined>;
  const names = [];
  for (const section of ["dependencies", "devDependencies"] as const) {
    for (const name of Object.keys(pkg[section] ?? {})) {
      if (targetPackage(name)) names.push(name);
    }
  }
  if (names.length === 0) throw new Error("no matching packages found");
  return names;
}

export function writeInstallCommand(path: string, packageNames: string[], version: string): void {
  const lines = ["#!/usr/bin/env bash", "set -euo pipefail", "npm install --save-dev --save-exact \\"];
  packageNames.forEach((name, index) => {
    lines.push(`  ${name}@${version}${index === packageNames.length - 1 ? "" : " \\"}`);
  });
  writeFileSync(path, `${lines.join("\n")}\n`);
  chmodSync(path, 0o755);
}

function writeReport(path: string, prep: PiUpdatePrep): void {
  writeFileSync(
    path,
    `# pi ${prep.version} update prep\n\n` +
      `Worktree: ${prep.worktree}\n` +
      `Branch: ${prep.branch}\n` +
      `Changelog section: ${prep.changelog}\n` +
      `Install command: ${prep.installCommand}\n\n` +
      `## Decision prompt\n\n` +
      `Review the changelog section against pi-env before applying. Check especially:\n\n` +
      `- package exports and imports used by extensions\n` +
      `- extension lifecycle/API changes\n` +
      `- settings, package loading, project trust, and resource discovery behavior\n` +
      `- CLI flags used by setup scripts, skills, and extension-spawned pi commands\n` +
      `- user-facing behavior that should be reported back\n\n` +
      `If no pi-env adjustments are required, run the install command in the worktree, run npm run verify, then commit, push, and file a PR.\n` +
      `If breaking or ambiguous changes exist, propose the pi-env adjustment plan before updating dependencies.\n`,
  );
}

async function fetchReleaseArtifacts(exec: Exec, prep: PiUpdatePrep): Promise<void> {
  const artifactDir = join(prep.worktree, ".pi-update", prep.version);
  const packageDir = join(artifactDir, "package");
  mkdirSync(packageDir, { recursive: true });

  const temp = join(tmpdir(), `pi-update-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(temp, { recursive: true });
  try {
    await run(exec, "npm", ["pack", `${PI_PACKAGE}@${prep.version}`, "--silent"], { cwd: temp });
    const tarball = readdirSync(temp).find((entry) => entry.endsWith(".tgz"));
    if (!tarball) throw new Error("npm pack did not produce a tarball");
    await run(exec, "tar", ["-xzf", join(temp, tarball), ...DOC_PATHS], { cwd: temp });
    cpSync(join(temp, "package"), packageDir, { recursive: true });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  const changelogPath = join(packageDir, "CHANGELOG.md");
  if (!existsSync(changelogPath)) throw new Error("package changelog not found");
  const section = extractChangelogSection(readFileSync(changelogPath, "utf8"), prep.version);
  if (!section.trim()) throw new Error(`changelog section for ${prep.version} not found`);
  writeFileSync(prep.changelog, section);

  writeInstallCommand(prep.installCommand, packageNames(join(prep.worktree, "package.json"), isPiPackageName), prep.version);
  writeReport(prep.report, prep);
}

export async function preparePiUpdate(exec: Exec, options: PiUpdateOptions): Promise<PiUpdatePrep> {
  const repo = await resolveRepo(exec, options.repo);
  const version = await resolveVersion(exec, options.version);
  const { branch, worktree } = await prepareWorktree(exec, repo, version, options.worktreeDir);
  const artifactDir = join(worktree, ".pi-update", version);
  const prep: PiUpdatePrep = {
    version,
    branch,
    worktree,
    report: join(artifactDir, "report.md"),
    changelog: join(artifactDir, "changelog-section.md"),
    installCommand: join(artifactDir, "install-command.sh"),
  };
  await fetchReleaseArtifacts(exec, prep);
  return prep;
}

export function buildDecisionPrompt(prep: PiUpdatePrep): string {
  return [
    `Continue the pi ${prep.version} update using the prepared artifacts.`,
    ``,
    `Prepared branch/worktree: ${prep.branch} at ${prep.worktree}`,
    `Report: ${prep.report}`,
    `Changelog section: ${prep.changelog}`,
    `Install command: ${prep.installCommand}`,
    ``,
    `Decision task: read the report and changelog section, compare the release against pi-env, and decide what is needed for this update. Focus on package exports/imports, extension lifecycle/API changes, settings/package/trust behavior, CLI flags used by setup/scripts/extensions, and user-facing changes to report back.`,
    ``,
    `If no pi-env adjustments are required, run the install command in the worktree, run npm run verify, commit as "chore: update pi to ${prep.version}", push, and file a PR. If changes are breaking or ambiguous, propose the adjustment plan before updating dependencies.`,
  ].join("\n");
}

export default function piUpdateExtension(pi: ExtensionAPI) {
  if (!isPiUpdateEnabled()) return;

  pi.registerCommand("pi-update", {
    description:
      "Prepare a pi dependency update worktree and changelog review, then hand off the decision task to the agent. Usage: /pi-update [version|latest] [--repo PATH] [--worktree-dir PATH]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const options = parseArgs(args);
      ctx.ui.notify(`Preparing pi update (${options.version})...`, "info");
      try {
        const prep = await preparePiUpdate(pi.exec.bind(pi), options);
        ctx.ui.notify(`pi update artifacts prepared for ${basename(prep.worktree)}`, "info");
        pi.sendUserMessage(buildDecisionPrompt(prep));
      } catch (error) {
        ctx.ui.notify(`pi-update failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
