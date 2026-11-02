import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { changedFiles } from "../changed-files.mjs";

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();

const it = test.extend({
  workspace: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), "changed-files-"));
    try {
      await writeFile(join(root, "value.ts"), "export const value = 1;\n");
      await writeFile(join(root, "unchanged.ts"), "export const unchanged = true;\n");
      git(root, "init", "-b", "main");
      git(root, "add", ".");
      git(root, "commit", "-m", "baseline");
      const base = git(root, "rev-parse", "HEAD");
      git(root, "checkout", "-b", "feature");
      await use({ root, base, changes: () => changedFiles({ cwd: root, env: {} }) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
});

for (const state of ["committed", "staged", "unstaged", "untracked with spaces"]) {
  it(`discovers ${state} paths without unchanged files`, async ({ workspace }) => {
    const file = state === "untracked with spaces" ? "new file.ts" : "value.ts";
    const source = "export const value = 2;\nexport const extra = 3;\n";
    await writeFile(join(workspace.root, file), source);
    if (state === "staged" || state === "committed") git(workspace.root, "add", file);
    if (state === "committed") git(workspace.root, "commit", "-m", "change");
    expect(workspace.changes()).toEqual({
      base: workspace.base,
      files: [file],
      existing: [file],
    });
  });
}

it("retains both rename paths for impact selection but only the existing destination for checks", async ({
  workspace,
}) => {
  git(workspace.root, "mv", "value.ts", "new name.ts");
  expect(workspace.changes()).toEqual({
    base: workspace.base,
    files: ["new name.ts", "value.ts"],
    existing: ["new name.ts"],
  });
});
