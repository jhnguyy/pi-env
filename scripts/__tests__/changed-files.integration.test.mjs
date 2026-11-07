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
      edited: [file],
      renames: [],
    });
  });
}

it("retains both rename paths for impact selection but checks only renamed content that changed", async ({
  workspace,
}) => {
  git(workspace.root, "mv", "value.ts", "new name.ts");
  git(workspace.root, "mv", "unchanged.ts", "moved.ts");
  await writeFile(join(workspace.root, "new name.ts"), "export const value = 2;\n");
  expect(workspace.changes()).toEqual({
    base: workspace.base,
    files: ["moved.ts", "new name.ts", "unchanged.ts", "value.ts"],
    edited: ["new name.ts"],
    renames: [{ from: "unchanged.ts", to: "moved.ts" }],
  });
});
