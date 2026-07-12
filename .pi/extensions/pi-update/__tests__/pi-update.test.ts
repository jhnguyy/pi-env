import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Fiber, Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  buildDecisionPrompt,
  extractChangelogSection,
  installCommandPrefix,
  isPiPackageName,
  packageManagerName,
  packageNames,
  packageNamesResult,
  parseArgs,
  PiUpdatePhase,
  writeInstallCommand,
  type PiUpdatePrep,
} from "../index";
import { isPiUpdateEnabled, preparePiUpdateEffect } from "../workflow";

type Exec = ExtensionAPI["exec"];

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });

function makePiUpdateFixture(): { repo: string; worktree: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pi-update-effect-test-"));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, "package.json"), JSON.stringify({ devDependencies: { "@earendil-works/pi-ai": "0.79.0" } }));
  return { repo, worktree, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function basePrepareExec(onCommand: Exec): Exec {
  return (command, args, options) => {
    if (command === "git" && args.join(" ") === "branch --show-current") return Promise.resolve(ok("main\n"));
    if (command === "git" && args.join(" ") === "status --porcelain=v1") return Promise.resolve(ok(""));
    if (command === "git" && args.join(" ") === "fetch origin") return Promise.resolve(ok(""));
    if (command === "git" && args.join(" ") === "merge --ff-only origin/main") return Promise.resolve(ok(""));
    if (command === "git" && args.join(" ") === "worktree list --porcelain") return Promise.resolve(ok(""));
    if (command === "git" && args[0] === "show-ref") return Promise.resolve({ ...ok(""), code: 1 });
    if (command === "git" && args[0] === "worktree" && args[1] === "add") return Promise.resolve(ok(""));
    return onCommand(command, args, options);
  };
}

describe("pi-update", () => {
  it("loads enabled setting through typed settings schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-update-test-"));
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ piUpdate: { enabled: true } }));

    expect(isPiUpdateEnabled(dir)).toBe(true);
  });

  it("defaults disabled and rejects malformed persisted enabled field", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-update-test-"));
    mkdirSync(join(dir, ".pi"));

    expect(isPiUpdateEnabled(dir)).toBe(false);
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ piUpdate: { enabled: "true" } }));
    expect(() => isPiUpdateEnabled(dir)).toThrow();
  });

  it("parses version and optional paths", () => {
    expect(parseArgs("0.80.0 --repo /repo --worktree-dir /tmp/wt")).toEqual({
      version: "0.80.0",
      repo: "/repo",
      worktreeDir: "/tmp/wt",
    });
  });

  it("defaults to latest", () => {
    expect(parseArgs("")).toEqual({ version: "latest" });
  });

  it("extracts only the requested changelog section", () => {
    const section = extractChangelogSection(`# Changelog\n\n## [0.80.0] - today\n\n- new\n\n## [0.79.0]\n\n- old\n`, "0.80.0");

    expect(section).toContain("## [0.80.0]");
    expect(section).toContain("- new");
    expect(section).not.toContain("0.79.0");
  });

  it("discovers pinned pi package names and writes the exact install command", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-update-test-"));
    const pkg = join(dir, "package.json");
    const command = join(dir, "install-command.sh");
    writeFileSync(pkg, JSON.stringify({ devDependencies: { "@earendil-works/pi-ai": "0.79.0", vitest: "^4" } }));

    const names = packageNames(pkg, isPiPackageName);
    writeInstallCommand(command, names, "0.80.0");

    expect(names).toEqual(["@earendil-works/pi-ai"]);
    expect(readFileSync(command, "utf8")).toContain("npm install --save-dev --save-exact");
    expect(readFileSync(command, "utf8")).toContain("@earendil-works/pi-ai@0.80.0");
  });

  it("uses nub workspace-root install commands for nub-managed repos", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-update-test-"));
    const pkg = join(dir, "package.json");
    const command = join(dir, "install-command.sh");
    writeFileSync(pkg, JSON.stringify({ packageManager: "nub@0.2.10", devDependencies: { "@earendil-works/pi-ai": "0.79.0" } }));

    writeInstallCommand(command, packageNames(pkg, isPiPackageName), "0.80.0", packageManagerName(pkg));

    expect(packageManagerName(pkg)).toBe("nub");
    expect(installCommandPrefix("nub")).toBe("nub install -W --save-dev --save-exact");
    expect(readFileSync(command, "utf8")).toContain("nub install -W --save-dev --save-exact");
  });

  it("returns tagged package discovery errors without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-update-test-"));
    const pkg = join(dir, "package.json");
    writeFileSync(pkg, JSON.stringify({ devDependencies: { vitest: "^4" } }));

    const result = packageNamesResult(pkg, isPiPackageName);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.phase).toBe(PiUpdatePhase.PackageDiscovery);
    }
  });

  it("creates a concise handoff prompt from prepared artifacts", () => {
    const prep: PiUpdatePrep = {
      version: "0.80.0",
      branch: "chore/update-pi-0.80.0",
      worktree: "/tmp/pi-env-update",
      report: "/tmp/pi-env-update/.pi-update/0.80.0/report.md",
      changelog: "/tmp/pi-env-update/.pi-update/0.80.0/changelog-section.md",
      installCommand: "/tmp/pi-env-update/.pi-update/0.80.0/install-command.sh",
    };

    const prompt = buildDecisionPrompt(prep);

    expect(prompt).toContain("Continue the pi 0.80.0 update");
    expect(prompt).toContain("read the report and changelog section");
    expect(prompt).toContain("chore: update pi to 0.80.0");
  });

  it("cleans the temporary release artifact directory when a command fails after creation", async () => {
    const fixture = makePiUpdateFixture();
    let temp: string | undefined;
    const exec = basePrepareExec((command, _args, options) => {
      if (command === "npm") {
        temp = options?.cwd;
        return Promise.resolve({ ...ok(""), stderr: "pack failed", code: 1 });
      }
      return Promise.resolve(ok(""));
    });

    try {
      await expect(Effect.runPromise(preparePiUpdateEffect(exec, { version: "0.80.0", repo: fixture.repo, worktreeDir: fixture.worktree }))).rejects.toThrow(
        "pi-update command failed: npm pack @earendil-works/pi-coding-agent@0.80.0 --silent exited 1: pack failed",
      );
      expect(temp).toBeDefined();
      expect(existsSync(temp!)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("passes Effect interruption to command exec and cleans the temporary release artifact directory", async () => {
    const fixture = makePiUpdateFixture();
    let temp: string | undefined;
    let commandSignal: AbortSignal | undefined;
    let started!: () => void;
    const commandStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const exec = basePrepareExec((command, _args, options) => {
      if (command === "npm") {
        temp = options?.cwd;
        commandSignal = options?.signal;
        started();
        return new Promise<ExecResult>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return Promise.resolve(ok(""));
    });

    try {
      const fiber = Effect.runFork(preparePiUpdateEffect(exec, { version: "0.80.0", repo: fixture.repo, worktreeDir: fixture.worktree }));
      await commandStarted;
      await Effect.runPromise(Fiber.interrupt(fiber));

      expect(commandSignal?.aborted).toBe(true);
      expect(temp).toBeDefined();
      expect(existsSync(temp!)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});
