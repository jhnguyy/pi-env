import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const snapshotScript = fileURLToPath(new URL("../trivy-snapshot.sh", import.meta.url));
const scanScript = fileURLToPath(new URL("../trivy-scan.sh", import.meta.url));
const directories = [];
const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(objectFormat = "sha1") {
  const directory = mkdtempSync(join(tmpdir(), "pi-env-trivy-snapshot-"));
  directories.push(directory);
  const repo = join(directory, "repo");
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe", env: gitEnvironment });
  git("init", "--initial-branch=main", `--object-format=${objectFormat}`);
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(repo, "tracked file.txt"), "committed\n");
  writeFileSync(join(repo, "deleted.txt"), "committed deletion control\n");
  symlinkSync("../outside.txt", join(repo, "link"));
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  );
  return { directory, repo, git };
}

describe("Trivy committed input boundary", () => {
  it.each(["sha1", "sha256"])(
    "exports committed %s bytes without dirty, staged, ignored, or untracked content",
    (objectFormat) => {
      const { directory, repo, git } = fixture(objectFormat);
      writeFileSync(join(repo, "tracked file.txt"), "staged change\n");
      writeFileSync(join(repo, "staged.txt"), "staged new file\n");
      git("add", ".");
      writeFileSync(join(repo, "tracked file.txt"), "unstaged change\n");
      rmSync(join(repo, "deleted.txt"));
      writeFileSync(join(repo, "ignored.txt"), "ignored synthetic private data\n");
      writeFileSync(join(repo, "untracked.txt"), "untracked\n");
      writeFileSync(join(directory, "outside.txt"), "outside synthetic private data\n");
      const output = join(directory, "snapshot");

      execFileSync("bash", [snapshotScript, output], { cwd: repo, env: gitEnvironment });

      expect(readdirSync(output).sort()).toEqual([
        ".gitignore",
        "deleted.txt",
        "link",
        "tracked file.txt",
      ]);
      expect(readFileSync(join(output, "tracked file.txt"), "utf8")).toBe("committed\n");
      expect(readFileSync(join(output, "deleted.txt"), "utf8")).toBe(
        "committed deletion control\n",
      );
      expect(readlinkSync(join(output, "link"))).toBe("../outside.txt");
    },
  );

  it("ignores archive transformations and local attribute overrides", () => {
    const { directory, repo, git } = fixture();
    writeFileSync(
      join(repo, ".gitattributes"),
      "deleted.txt export-ignore\ntracked* export-subst\n",
    );
    writeFileSync(join(repo, "tracked file.txt"), "$Format:%H$\n");
    mkdirSync(join(repo, "nested"));
    writeFileSync(join(repo, "nested", ".gitattributes"), "* export-ignore export-subst\n");
    writeFileSync(join(repo, "nested", "literal.txt"), "$Format:%H$\n");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "archive attribute fixture",
    );
    writeFileSync(join(repo, ".git", "info", "attributes"), ".gitignore export-ignore\n");
    const globalAttributes = join(directory, "global-attributes");
    writeFileSync(globalAttributes, "* export-ignore export-subst\n");
    const globalConfig = join(directory, "global-config");
    writeFileSync(globalConfig, `[core]\nattributesFile = ${globalAttributes}\n`);
    const output = join(directory, "snapshot");

    execFileSync("bash", [snapshotScript, output], {
      cwd: repo,
      env: { ...gitEnvironment, GIT_CONFIG_GLOBAL: globalConfig },
    });

    expect(readFileSync(join(output, "deleted.txt"), "utf8")).toBe("committed deletion control\n");
    expect(readFileSync(join(output, "tracked file.txt"), "utf8")).toBe("$Format:%H$\n");
    expect(readFileSync(join(output, ".gitignore"), "utf8")).toBe("ignored.txt\n");
    expect(readFileSync(join(output, "nested", "literal.txt"), "utf8")).toBe("$Format:%H$\n");
  });

  it("exports a linked worktree through its shared object directory", () => {
    const { directory, git } = fixture();
    const worktree = join(directory, "worktree");
    git("worktree", "add", "--detach", worktree, "HEAD");
    const output = join(directory, "snapshot");
    execFileSync("bash", [snapshotScript, output], { cwd: worktree, env: gitEnvironment });
    expect(readFileSync(join(output, "tracked file.txt"), "utf8")).toBe("committed\n");
  });

  it("refuses an existing destination instead of mixing inputs", () => {
    const { directory, repo } = fixture();
    const output = join(directory, "snapshot");
    mkdirSync(output);
    writeFileSync(join(output, "untrusted.txt"), "must not be scanned\n");
    const result = spawnSync("bash", [snapshotScript, output], {
      cwd: repo,
      encoding: "utf8",
      env: gitEnvironment,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("File exists");
    expect(readdirSync(output)).toEqual(["untrusted.txt"]);
  });

  it.each(["auto", "docker", "podman"])(
    "fails closed when runtime %s is unavailable",
    (runtime) => {
      const { directory, repo } = fixture();
      const bin = join(directory, "bin");
      mkdirSync(bin);
      const commandPath = (name) =>
        execFileSync("bash", ["-c", 'command -v "$1"', "_", name], { encoding: "utf8" }).trim();
      symlinkSync(commandPath("dirname"), join(bin, "dirname"));
      const result = spawnSync(commandPath("bash"), [scanScript], {
        cwd: repo,
        encoding: "utf8",
        env: { ...gitEnvironment, PATH: bin, TRIVY_RUNTIME: runtime },
      });
      expect(result.status).toBe(127);
      expect(result.stderr).toContain(
        runtime === "auto" ? "requires Docker or Podman" : "is not on PATH",
      );
    },
  );

  it.each(["local", "trivy"])("rejects host runtime %s before scanning", (runtime) => {
    const { repo } = fixture();
    const result = spawnSync("bash", [scanScript], {
      cwd: repo,
      encoding: "utf8",
      env: { ...gitEnvironment, TRIVY_RUNTIME: runtime },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Host Trivy execution is disabled");
  });
});
