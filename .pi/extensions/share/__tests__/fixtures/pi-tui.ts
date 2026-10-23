import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { onTestFinished } from "vitest";

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function piTui(extensions: string[], args: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "pi-share-hook-e2e-"));
  const socket = join(root, "tmux.sock");
  const ghLog = join(root, "gh.log");
  const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], { encoding: "utf8" });
  let screen = "";
  let verdict = "fail";
  let input = "";
  let expected = "";
  onTestFinished(() => {
    const errors: unknown[] = [];
    const attempt = (cleanup: () => void) => {
      try { cleanup(); } catch (error) { errors.push(error); }
    };
    attempt(() => {
      const evidence = process.env["PI_ENV_E2E_ARTIFACT_DIR"] ?? join(tmpdir(), "pi-share-evidence");
      mkdirSync(evidence, { recursive: true });
      const path = join(evidence, `share-${Date.now()}-${root.split("-").at(-1)}.json`);
      writeFileSync(path, JSON.stringify({ input, expected, actual: screen, ghCalls: existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "", verdict, repeat: "E2E=1 nub run test:vitest .pi/extensions/share/__tests__/e2e.test.ts" }, null, 2));
      console.log(`Share TUI evidence: ${path}`);
    });
    attempt(() => { if (existsSync(socket)) tmux("kill-server"); });
    attempt(() => rmSync(root, { recursive: true, force: true }));
    if (errors.length > 0) throw new AggregateError(errors, "Share E2E teardown failed");
  });

  const agent = join(root, "agent");
  const bin = join(root, "bin");
  mkdirSync(agent);
  mkdirSync(bin);
  // Native-sharing negative controls cannot reach credentials or publish a gist.
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(ghLog)}\nexit 73\n`, { mode: 0o755 });
  const settings = join(agent, "settings.json");
  writeFileSync(settings, JSON.stringify({ quietStartup: true, tuiMode: "regular", sessionShareDestination: "gist" }));
  const session = SessionManager.create(root, join(root, "sessions"));
  session.appendMessage({ role: "user", content: "synthetic share dispatch check", timestamp: Date.now() });
  const cli = join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const invocation = [process.execPath, cli, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", ...extensions.flatMap((path) => ["-e", path]), "--session", session.getSessionFile()!, "--offline", ...args];
  tmux("new-session", "-d", "-s", "share", "-x", "120", "-y", "40", `env -i HOME=${quote(root)} USER=agent TERM=xterm-256color LANG=C.UTF-8 PATH=${quote(`${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`)} PI_CODING_AGENT_DIR=${quote(agent)} PI_OFFLINE=1 ${invocation.map(quote).join(" ")}`);

  return {
    settings,
    ghCalls: () => existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "",
    send(text: string) { input = text; tmux("send-keys", "-t", "share", "-l", text); tmux("send-keys", "-t", "share", "Enter"); },
    escape() { tmux("send-keys", "-t", "share", "Escape"); },
    async waitFor(text: string) {
      expected = text;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        screen = tmux("capture-pane", "-p", "-t", "share");
        if (screen.includes(text)) return screen;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Did not see ${text}: ${screen}`);
    },
    passed() { verdict = "pass"; },
  };
}
