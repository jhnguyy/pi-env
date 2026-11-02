import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it, onTestFinished } from "vitest";

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

it("/share-private in real Pi opens the repository prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-private-share-e2e-"));
  const socket = join(root, "tmux.sock");
  const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], { encoding: "utf8" });
  let screen = "";
  let verdict = "fail";
  onTestFinished(() => {
    const errors: unknown[] = [];
    const attempt = (cleanup: () => void) => {
      try { cleanup(); } catch (error) { errors.push(error); }
    };
    attempt(() => { if (existsSync(socket)) tmux("kill-server"); });
    attempt(() => rmSync(root, { recursive: true, force: true }));
    if (errors.length) verdict = "fail";
    attempt(() => {
      const evidence = process.env["PI_ENV_E2E_ARTIFACT_DIR"] ?? join(tmpdir(), "pi-share-evidence");
      mkdirSync(evidence, { recursive: true });
      const path = join(evidence, `share-${Date.now()}.json`);
      writeFileSync(path, JSON.stringify({ input: "/share-private in an isolated Pi TUI", expected: "Repository prompt appears; cancelling dismisses it without saving a share default", actual: screen, verdict, repeat: "nub run test:e2e .pi/extensions/share/__tests__/e2e.test.ts" }, null, 2));
      console.log(`Share TUI evidence: ${path}`);
    });
    if (errors.length > 0) throw new AggregateError(errors, "Share E2E teardown failed");
  });

  const agent = join(root, "agent");
  mkdirSync(agent);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ quietStartup: true, tuiMode: "regular" }));
  const session = SessionManager.create(root, join(root, "sessions"));
  session.appendMessage({ role: "user", content: "synthetic share routing check", timestamp: Date.now() });
  const cli = join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const extension = join(process.cwd(), ".pi/extensions/share/dist/index.js");
  tmux("new-session", "-d", "-s", "share", "-x", "120", "-y", "40", `env PI_CODING_AGENT_DIR=${quote(agent)} PI_OFFLINE=1 ${quote(process.execPath)} ${quote(cli)} --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files -e ${quote(extension)} --session ${quote(session.getSessionFile()!)} --offline`);
  const waitFor = async (matches: (screen: string) => boolean) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      screen = tmux("capture-pane", "-p", "-t", "share");
      if (matches(screen)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Expected screen state was not reached: ${screen}`);
  };
  await waitFor((text) => text.includes("No models available"));
  tmux("send-keys", "-t", "share", "-l", "/share-private");
  tmux("send-keys", "-t", "share", "Enter");
  await waitFor((text) => text.includes("Private GitHub repository"));
  expect(screen).toContain("saved as your default");
  tmux("send-keys", "-t", "share", "Escape");
  await waitFor((text) => !text.includes("Private GitHub repository"));
  expect(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"))).not.toHaveProperty("share");
  verdict = "pass";
});
