import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it, onTestFinished } from "vitest";

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const test = process.env["E2E"] === "1" ? it : it.skip;

test("/share-private in real Pi opens the repository prompt", async () => {
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
    attempt(() => {
      const evidence = process.env["PI_ENV_E2E_ARTIFACT_DIR"] ?? join(tmpdir(), "pi-share-evidence");
      mkdirSync(evidence, { recursive: true });
      const path = join(evidence, `share-${Date.now()}.json`);
      writeFileSync(path, JSON.stringify({ input: "/share-private in an isolated Pi TUI", expected: "Private repository prompt, no gist publication", actual: screen, verdict, repeat: "E2E=1 nub run test:vitest .pi/extensions/share/__tests__/e2e.test.ts" }, null, 2));
      console.log(`Share TUI evidence: ${path}`);
    });
    attempt(() => { if (existsSync(socket)) tmux("kill-server"); });
    attempt(() => rmSync(root, { recursive: true, force: true }));
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
  const deadline = Date.now() + 15_000;
  const waitFor = async (text: string) => {
    while (Date.now() < deadline) {
      screen = tmux("capture-pane", "-p", "-t", "share");
      if (screen.includes(text)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Did not see ${text}: ${screen}`);
  };
  await waitFor("No models available");
  tmux("send-keys", "-t", "share", "-l", "/share-private");
  tmux("send-keys", "-t", "share", "Enter");
  await waitFor("Private GitHub repository");
  expect(screen).toContain("saved as your default");
  expect(screen).not.toContain("gist.github.com");
  tmux("send-keys", "-t", "share", "Escape");
  expect(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"))).not.toHaveProperty("share");
  verdict = "pass";
});
