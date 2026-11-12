import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import {
  CHILD_USAGE_ENTRY_TYPE,
  SubagentUsageAccounting,
  usageFromEntries,
  type ChildUsageSnapshot,
} from "../usage-accounting";

function nativeUsage(n: number): Usage {
  return {
    input: n * 10,
    output: n * 2,
    cacheRead: n * 3,
    cacheWrite: n * 4,
    totalTokens: n * 19,
    cost: { input: n, output: 0, cacheRead: 0, cacheWrite: 0, total: n },
  };
}

function assistant(manager: SessionManager, n: number): string {
  return manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "fixture" }],
    api: "anthropic-messages",
    provider: "fixture",
    model: "fixture",
    usage: nativeUsage(n),
    stopReason: "stop",
    timestamp: 1,
  });
}

describe("native parent child-usage accounting", () => {
  let root: string;
  let parent: SessionManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "subagent-accounting-"));
    const home = join(root, "home");
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    parent = SessionManager.create(root, join(agentDir, "sessions"));
    parent.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function accounting(manager = parent) {
    const ledger = new SubagentUsageAccounting((type, data) => {
      manager.appendCustomEntry(type, data);
    });
    const report = ledger.start(manager);
    return { ledger, report };
  }

  function child(n = 2): SessionManager {
    const manager = SessionManager.create(root, join(root, "children"), {
      parentSession: parent.getSessionFile(),
    });
    assistant(manager, n);
    return manager;
  }

  function snapshot(manager: SessionManager): ChildUsageSnapshot {
    return {
      childSessionId: manager.getSessionId(),
      name: "worker",
      sessionFile: manager.getSessionFile(),
      usage: usageFromEntries(manager.getEntries()),
    };
  }

  it("replaces cumulative child costs without charging repeated snapshots", () => {
    assistant(parent, 1);
    const worker = child();
    const { ledger, report } = accounting();
    report(snapshot(worker));
    report(snapshot(worker));
    expect(ledger.summary().children.cost).toBe(2);
    assistant(worker, 3);
    report(snapshot(worker));
    expect(ledger.summary()).toMatchObject({
      parent: { cost: 1 },
      children: { cost: 5 },
      total: { cost: 6 },
      childCount: 1,
      unavailableChildren: [],
    });
  });

  it("bills all raw branches, native usage, tool results and summaries despite compaction/context edits", () => {
    const first = assistant(parent, 1);
    const abandoned = assistant(parent, 2);
    const worker = child();
    accounting().report(snapshot(worker));
    child(50); // An unregistered native session is not a delegated cost reference.
    parent.branch(first);
    parent.appendUsage("unknown-operation", "fixture", "fixture", nativeUsage(3));
    parent.appendMessage({
      role: "toolResult",
      toolCallId: "legacy",
      toolName: "subagent",
      content: [],
      usage: nativeUsage(4),
      isError: false,
      timestamp: 1,
    });
    parent.appendCompaction("summary", null, 100, undefined, false, nativeUsage(5));
    parent.branchWithSummary(first, "branch summary", undefined, false, nativeUsage(6));
    parent.appendContextEdit(first, null);
    expect(parent.buildContextEntries().some((e) => e.id === abandoned)).toBe(false);
    const { ledger } = accounting();
    expect(ledger.summary()).toMatchObject({
      parent: { cost: 21, input: 210, output: 42, cacheRead: 63, cacheWrite: 84, turns: 2 },
      children: { cost: 2 },
      total: { cost: 23 },
      childCount: 1,
    });
    assistant(parent, 7);
    expect(ledger.summary().parent.cost).toBe(28);
  });

  it("recovers the child/parent checkpoint gap through fresh native readers only at startup", () => {
    const worker = child();
    const { ledger, report } = accounting();
    report(snapshot(worker));
    assistant(worker, 3); // Child JSONL reached disk before the next parent checkpoint.
    const childBytes = readFileSync(worker.getSessionFile()!, "utf8");
    expect(ledger.summary().children.cost).toBe(2);
    const freshParent = SessionManager.open(parent.getSessionFile()!);
    const fresh = accounting(freshParent).ledger;
    expect(fresh.summary().children.cost).toBe(5);
    expect(readFileSync(worker.getSessionFile()!, "utf8")).toBe(childBytes);
    expect(
      accounting(SessionManager.open(parent.getSessionFile()!)).ledger.summary().children.cost,
    ).toBe(5);
  });

  it.each(["valid", "partial"] as const)(
    "never repairs a child file with a %s unterminated final line",
    (ending) => {
      const worker = child();
      accounting().report(snapshot(worker));
      assistant(worker, 3);
      const file = worker.getSessionFile()!;
      const content =
        readFileSync(file, "utf8").trimEnd() + (ending === "partial" ? '\n{"type":' : "");
      writeFileSync(file, content);
      const reloaded = accounting(SessionManager.open(parent.getSessionFile()!)).ledger;
      expect(readFileSync(file, "utf8")).toBe(content);
      const summary = reloaded.summary();
      expect(summary.children.cost).toBe(ending === "valid" ? 5 : 2);
      expect(summary.unavailableChildren).toHaveLength(ending === "valid" ? 0 : 1);
    },
  );

  it("reports invalid checkpoint amounts as unavailable rather than silently dropping them", () => {
    parent.appendCustomEntry(CHILD_USAGE_ENTRY_TYPE, {
      version: 1,
      childSessionId: "unknown",
      name: "worker",
      parentSessionId: parent.getSessionId(),
      usage: { cost: "not a cost" },
    });
    const summary = accounting().ledger.summary();
    expect(summary.unavailableChildren).toEqual([
      { name: "Unknown child", reason: expect.stringContaining("Invalid child-usage checkpoint") },
    ]);
  });

  it("keeps last known costs and explicitly reports missing saved child files", () => {
    const worker = child();
    const { report } = accounting();
    report(snapshot(worker));
    rmSync(worker.getSessionFile()!);
    const { ledger } = accounting(SessionManager.open(parent.getSessionFile()!));
    expect(ledger.summary()).toMatchObject({
      children: { cost: 2 },
      childCount: 1,
      unavailableChildren: [
        { childSessionId: worker.getSessionId(), name: "worker", reason: expect.any(String) },
      ],
    });
  });

  it.each(["identity", "parent", "invalid", "legacy", "empty", "truncated", "usage"])(
    "retains the checkpoint without rewriting a %s child reference",
    (failure) => {
      const worker = child();
      const { report } = accounting();
      report(snapshot(worker));
      const file = worker.getSessionFile()!;
      let bytes = readFileSync(file, "utf8");
      if (failure === "invalid") bytes = "not JSON\n";
      else if (failure === "empty") bytes = "";
      else {
        const lines = bytes.trimEnd().split("\n");
        const header = JSON.parse(lines[0]);
        if (failure === "identity") header.id = "unrelated";
        if (failure === "parent") header.parentSession = join(root, "other-parent.jsonl");
        if (failure === "legacy") header.version = 2;
        lines[0] = JSON.stringify(header);
        if (failure === "truncated") lines.splice(1);
        if (failure === "usage") {
          const message = JSON.parse(lines[1]);
          message.message.usage.cost.total = "3";
          lines[1] = JSON.stringify(message);
        }
        bytes = lines.join("\n") + "\n";
      }
      writeFileSync(file, bytes);
      const { ledger } = accounting(SessionManager.open(parent.getSessionFile()!));
      expect(ledger.summary().children.cost).toBe(2);
      expect(ledger.summary().unavailableChildren).toHaveLength(1);
      expect(readFileSync(file, "utf8")).toBe(bytes);
    },
  );

  it("freezes inherited fork costs while the originating parent can recover later growth", () => {
    const worker = child();
    accounting().report(snapshot(worker));
    const fork = SessionManager.forkFrom(parent.getSessionFile()!, root, join(root, "forks"));
    assistant(worker, 3);
    const forkAccounting = accounting(fork).ledger;
    expect(forkAccounting.summary()).toMatchObject({
      children: { cost: 2 },
      unavailableChildren: [],
    });
    expect(
      accounting(SessionManager.open(parent.getSessionFile()!)).ledger.summary().children.cost,
    ).toBe(5);
    rmSync(worker.getSessionFile()!);
    expect(accounting(SessionManager.open(fork.getSessionFile()!)).ledger.summary()).toMatchObject({
      children: { cost: 2 },
      unavailableChildren: [],
    });
  });

  it("invalidates old reporters on successor sessions and same-identity resume generations", () => {
    const worker = child();
    const { ledger, report } = accounting();
    report(snapshot(worker));
    const resumedReporter = ledger.start(parent);
    report({ ...snapshot(worker), usage: { ...snapshot(worker).usage, cost: 99 } });
    expect(ledger.summary().children.cost).toBe(2);
    resumedReporter({ ...snapshot(worker), usage: { ...snapshot(worker).usage, cost: 3 } });
    expect(ledger.summary().children.cost).toBe(3);
    parent.newSession(); // Native manager itself may change identity before start is emitted.
    const count = parent.getEntries().length;
    resumedReporter(snapshot(worker));
    expect(parent.getEntries()).toHaveLength(count);
    ledger.start(parent);
    report(snapshot(worker));
    resumedReporter(snapshot(worker));
    expect(ledger.summary().childCount).toBe(0);
    expect(parent.getEntries()).toHaveLength(count);
  });

  it("supports ephemeral parents without attempting saved-child recovery or promising restart durability", () => {
    parent = SessionManager.inMemory(root);
    const worker = child();
    const { ledger, report } = accounting();
    report(snapshot(worker));
    rmSync(worker.getSessionFile()!);
    expect(accounting(parent).ledger.summary()).toEqual(ledger.summary());
    expect(ledger.summary()).toMatchObject({ children: { cost: 2 }, unavailableChildren: [] });
    expect(accounting(SessionManager.inMemory(root)).ledger.summary().childCount).toBe(0);
  });
});
