import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import * as TempDir from "../../../src/testing/temp-dir";
import { TodoStore } from "../store";

afterEach(() => vi.unstubAllEnvs());

it("preserves handoffs across merge/pull output while retaining todo and status context", async () => {
  const home = TempDir.forTestSync("tracker-handoffs-");
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi/agent"));
  const directory = join(home, ".pi/agent/handoffs");
  mkdirSync(directory, { recursive: true });
  const files = ["repo-a", "repo-b"].map((repo) => {
    const path = join(directory, `${repo}.md`);
    const content = `---\nrepo: ${repo}\nbranch: feat/shared\n---\nKeep this handoff.\n`;
    writeFileSync(path, content);
    return { path, content };
  });
  const repo = join(home, "repo-a");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-b", "main");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "baseline",
  );
  git("branch", "feat/shared");
  writeFileSync(join(repo, "dirty.txt"), "uncommitted");

  // Import only after isolating HOME: the retired implementation captures it.
  const { registerHooks } = await import("../hooks");
  const handlers = new Map<string, unknown[]>();
  const pi: Pick<ExtensionAPI, "on"> = {
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
  };
  const store = new TodoStore();
  store.add("keep the current task");
  registerHooks(pi as ExtensionAPI, { guardedRepos: [repo], protectedBranches: ["main"] }, store);
  const context = { hasUI: false, ui: { notify: () => {} } };
  const emit = async (name: string, event: unknown) =>
    Promise.all(
      (handlers.get(name) ?? []).map((handler) => {
        if (typeof handler !== "function") throw new Error("Invalid registered handler");
        return handler(event, context);
      }),
    );
  for (const command of [
    `git -C ${repo} merge feat/shared`,
    `git -C ${repo} pull`,
    'echo git merge feat/shared "Merge made by"',
  ]) {
    await emit("tool_result", {
      toolName: "bash",
      isError: false,
      input: { command },
      content: [{ type: "text", text: "Merge made by the 'ort' strategy." }],
    });
    for (const file of files) expect(readFileSync(file.path, "utf8")).toBe(file.content);
  }
  const messages = await emit("before_agent_start", {});
  expect(messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        message: expect.objectContaining({ customType: "session-todos" }),
      }),
      expect.objectContaining({ message: expect.objectContaining({ customType: "work-tracker" }) }),
    ]),
  );
  expect(store.open().map((item) => item.text)).toEqual(["keep the current task"]);
});
