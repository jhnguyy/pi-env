import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import type { Exec } from "../host.js";

export function testSocket(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-session-host-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "tmux.sock");
}

// Model command output, not host ownership policy. createTmuxSessionHost owns
// reclaim, conflict checks, labels, and locking in both consuming suites.
export function executor(
  initialTags: Readonly<Record<string, string>> = {},
  initialOwners: Readonly<Record<string, string>> = {},
  socketPath = testSocket(),
) {
  const options: Record<string, Record<string, string>> = {
    "@pi_session_id": { ...initialTags },
    "@pi_session_pid": { ...initialOwners },
  };
  const tags = options["@pi_session_id"];
  const owners = options["@pi_session_pid"];
  const labels: Record<string, string> = {};
  const calls: string[][] = [];
  const exec: Exec = async (command, args) => {
    calls.push([command, ...args]);
    const format = args.at(-1);
    if (args.includes("list-windows")) return { code: 0, stdout: "@1\n@2\n", stderr: "" };
    if (format === "#{socket_path}") return { code: 0, stdout: `${socketPath}\n`, stderr: "" };
    if (format === "#{session_id}") return { code: 0, stdout: "$1\n", stderr: "" };
    if (format === "#{window_id}") return { code: 0, stdout: "@1\n", stderr: "" };
    const windowId = args[args.indexOf("-t") + 1];
    if (format === "#{window_name}") {
      return { code: 0, stdout: `${labels[windowId] ?? ""}\n`, stderr: "" };
    }
    if (args.includes("rename-window")) labels[windowId] = args.at(-1)!;
    const option = Object.keys(options).find((name) => args.includes(name));
    if (args.includes("show-options") && option) {
      return { code: 0, stdout: `${options[option][windowId] ?? ""}\n`, stderr: "" };
    }
    if (args.includes("set-option") && option) {
      if (args.includes("-u")) delete options[option][windowId];
      else if (args.includes("-o") && options[option][windowId])
        return { code: 1, stdout: "", stderr: "already set" };
      else options[option][windowId] = args.at(-1)!;
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec, tags, owners, labels };
}
