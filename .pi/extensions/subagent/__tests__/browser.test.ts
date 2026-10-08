import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSubagentHarness } from "./harness";

import { SubagentBrowser } from "../browser";
import { readChildTranscript, TRANSCRIPT_READ_BYTES } from "../transcript";
import * as transcriptReader from "../transcript";
import type { SubagentJob } from "../jobs";
import type { RunSubagentOptions } from "../execute";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function transcript(content: string) {
  const directory = await mkdtemp(join(tmpdir(), "subagent-browser-"));
  directories.push(directory);
  const path = join(directory, "child.jsonl");
  await writeFile(path, content);
  return path;
}

function message(role: string, text: string) {
  return (
    JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } }) + "\n"
  );
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe("registered /subagents workflow", () => {
  it("views a real running child transcript and returns to the unchanged parent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subagent-browser-workflow-"));
    directories.push(directory);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const agentLoop: NonNullable<RunSubagentOptions["agentLoop"]> = (
      _prompts,
      _context,
      _config,
      signal,
    ) =>
      ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Child evidence" }],
              timestamp: Date.now(),
              model: "test-model",
              stopReason: "stop",
              usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
            },
          };
          await Promise.race([
            gate,
            new Promise<void>((resolve) =>
              signal?.addEventListener("abort", () => resolve(), { once: true }),
            ),
          ]);
          yield { type: "turn_end" };
        },
        async result() {
          return [];
        },
      }) as any;
    const { commands, handlers, tools } = createSubagentHarness({ agentLoop });
    const parent = SessionManager.create(directory, directory);
    let component: SubagentBrowser | undefined;
    let endInteraction!: () => void;
    const draft = "Keep this parent draft";
    const ui = {
      theme,
      setWidget: vi.fn(),
      notify: vi.fn(),
      getEditorText: () => draft,
      setEditorText: vi.fn(),
      custom: vi.fn(
        (factory: any) =>
          new Promise<void>((resolve) => {
            endInteraction = resolve;
            component = factory(
              { requestRender: vi.fn(), terminal: { rows: 40 } },
              theme,
              {},
              resolve,
            );
          }),
      ),
    };
    const ctx = {
      cwd: directory,
      mode: "tui",
      hasUI: true,
      sessionManager: parent,
      ui,
      switchSession: vi.fn(),
      waitForIdle: vi.fn(),
      modelRegistry: {
        find: () => ({ provider: "test", id: "test-model" }),
        getAvailable: () => [{ provider: "test", id: "test-model", name: "Test" }],
        getApiKeyForProvider: async () => "test-key",
      },
    } as any;
    const command = commands.get("subagents");
    const tool = tools.get("subagent");
    try {
      await handlers.get("session_start")!({}, ctx);
      const started = await tool.execute(
        "start",
        {
          action: "start",
          name: "investigation",
          task: "Inspect",
          tools: ["read"],
          model: "test/test-model",
        },
        undefined,
        undefined,
        ctx,
      );
      const status = () =>
        tool.execute(
          "status",
          { action: "status", job_id: started.details.jobId },
          undefined,
          undefined,
          ctx,
        );
      await vi.waitFor(async () => expect((await status()).details.sessionFile).toBeTruthy());
      const parentFile = parent.getSessionFile();
      const interaction = command.handler("", ctx);
      expect(component).toBeDefined();
      component!.handleInput("\r");
      await vi.waitFor(() => expect(component!.render(80).join("\n")).toContain("Child evidence"));
      expect((await status()).details.status).toBe("running");
      component!.handleInput("\u001b");
      component!.handleInput("\u001b");
      endInteraction();
      await interaction;
      expect((await status()).details.status).toBe("running");
      expect(ctx.switchSession).not.toHaveBeenCalled();
      expect(ctx.waitForIdle).not.toHaveBeenCalled();
      expect(ui.setEditorText).not.toHaveBeenCalled();
      expect(ui.getEditorText()).toBe(draft);
      expect(parent.getSessionFile()).toBe(parentFile);
      finish();
      const result = await tool.execute(
        "wait",
        { action: "wait", job_id: started.details.jobId },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.status).toBe("completed");
      const artifacts = process.env.PI_ENV_SUBAGENT_BROWSER_ARTIFACT_DIR;
      if (artifacts) {
        await mkdir(artifacts, { recursive: true });
        await writeFile(
          join(artifacts, "workflow-result.json"),
          JSON.stringify(
            {
              workflow:
                "registered /subagents command with real child transcript storage and injected agent loop",
              input:
                "start child, inspect finalized output while running, escape twice, collect result",
              expected:
                "same parent and draft, child remains running until released, then completes",
              actual: "same parent and draft, no session switch or idle wait, child completed",
              verdict: "pass",
              reproduce:
                "PI_ENV_SUBAGENT_BROWSER_ARTIFACT_DIR=<dir> nub run test:vitest .pi/extensions/subagent/__tests__/browser.test.ts",
            },
            null,
            2,
          ),
        );
      }
    } finally {
      finish();
      component?.dispose();
      await handlers.get("session_shutdown")!({}, ctx);
    }
  });

  it.each(["before persistence", "finalized error", "finalized abort"] as const)(
    "shows the retained diagnostic after a child failure: %s",
    async (failure) => {
      const directory = await mkdtemp(join(tmpdir(), "subagent-browser-failure-"));
      directories.push(directory);
      const diagnostic = "429: quota exhausted";
      const agentLoop: NonNullable<RunSubagentOptions["agentLoop"]> = () =>
        ({
          async *[Symbol.asyncIterator]() {
            if (failure === "before persistence") throw new Error(diagnostic);
            yield {
              type: "message_end",
              message: {
                role: "assistant",
                content: [],
                timestamp: Date.now(),
                model: "test-model",
                stopReason: failure === "finalized abort" ? "aborted" : "error",
                errorMessage: diagnostic,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
              },
            };
            yield { type: "turn_end" };
          },
          async result() {
            return [];
          },
        }) as any;
      const { commands, handlers, tools } = createSubagentHarness({ agentLoop });
      let component: SubagentBrowser | undefined;
      const ctx = {
        cwd: directory,
        mode: "tui",
        hasUI: true,
        sessionManager: SessionManager.create(directory, directory),
        ui: {
          theme,
          setWidget: vi.fn(),
          notify: vi.fn(),
          custom: (factory: any) =>
            new Promise<void>((resolve) => {
              component = factory(
                { requestRender: vi.fn(), terminal: { rows: 40 } },
                theme,
                {},
                resolve,
              );
            }),
        },
        modelRegistry: {
          find: () => ({ provider: "test", id: "test-model" }),
          getAvailable: () => [{ provider: "test", id: "test-model", name: "Test" }],
          getApiKeyForProvider: async () => "test-key",
        },
      } as any;
      try {
        await handlers.get("session_start")!({}, ctx);
        const tool = tools.get("subagent");
        const started = await tool.execute(
          "start",
          {
            action: "start",
            name: "failure",
            task: "Inspect",
            tools: ["read"],
            model: "test/test-model",
          },
          undefined,
          undefined,
          ctx,
        );
        const result = await tool.execute(
          "wait",
          { action: "wait", job_id: started.details.jobId },
          undefined,
          undefined,
          ctx,
        );
        expect(result.details.status).toBe(
          failure === "finalized abort" ? "interrupted" : "failed",
        );
        expect(result.details.sessionFile).toBeTruthy();
        const interaction = commands.get("subagents").handler("", ctx);
        component!.handleInput("\r");
        await vi.waitFor(() => expect(component!.render(100).join("\n")).toContain(diagnostic));
        if (failure !== "before persistence") {
          expect(component!.render(100).join("\n")).not.toContain(
            "No finalized child messages yet.",
          );
        }
        const artifacts = process.env.PI_ENV_SUBAGENT_BROWSER_ARTIFACT_DIR;
        if (artifacts) {
          await mkdir(artifacts, { recursive: true });
          await writeFile(
            join(artifacts, `failure-${failure.replaceAll(" ", "-")}.json`),
            JSON.stringify(
              {
                input: failure,
                expected: "retained diagnostic visible in the registered read-only browser",
                actual: component!.render(100),
                verdict: "pass",
                reproduce:
                  "PI_ENV_SUBAGENT_BROWSER_ARTIFACT_DIR=<dir> nub run test:vitest .pi/extensions/subagent/__tests__/browser.test.ts",
              },
              null,
              2,
            ),
          );
        }
        component!.close();
        await interaction;
      } finally {
        component?.close();
        await handlers.get("session_shutdown")!({}, ctx);
      }
    },
  );

  it("rejects non-TUI clients without creating a custom component", async () => {
    const { commands } = createSubagentHarness();
    const custom = vi.fn();
    const notify = vi.fn();
    await commands.get("subagents").handler("", { mode: "rpc", ui: { custom, notify } });
    expect(custom).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "/subagents requires interactive terminal mode.",
      "warning",
    );
  });
});

// A live terminal cannot reliably inject partial JSONL writes, hostile controls, or late polling results.
describe("read-only child transcript boundary", () => {
  it("ignores malformed records and strips terminal controls without rewriting the file", async () => {
    const raw =
      message("user", "Inspect files") +
      "null\n{broken\n" +
      message("assistant", "\u001b]52;c;secret\u0007Hello\u001b[2J\u0000 world") +
      '{"type":"message"';
    const path = await transcript(raw);
    const result = await readChildTranscript(path);
    expect(result.text).toContain("Hello world");
    expect(result.text).not.toMatch(/[\u0000\u0007\u001b]/);
    expect(await readFile(path, "utf8")).toBe(raw);
  });

  it.each(["error", "aborted"])(
    "preserves finalized %s diagnostics without text content",
    async (stopReason) => {
      const raw =
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [],
            stopReason,
            errorMessage: "\u001b]52;c;secret\u0007quota\u001b[2J exhausted",
          },
        }) + "\n";
      const path = await transcript(raw);
      const result = await readChildTranscript(path);
      expect(result.text).toContain(
        stopReason === "error" ? "Error: quota exhausted" : "Aborted: quota exhausted",
      );
      expect(result.text).not.toMatch(/[\u0007\u001b]/);
      expect(await readFile(path, "utf8")).toBe(raw);
    },
  );

  it("bounds large transcripts and reports omitted history", async () => {
    const path = await transcript(
      message("assistant", "x".repeat(TRANSCRIPT_READ_BYTES * 2)) +
        message("assistant", "latest result"),
    );
    const result = await readChildTranscript(path);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("latest result");
    expect(result.text.length).toBeLessThanOrEqual(TRANSCRIPT_READ_BYTES);
  });

  it("reports unavailable transcripts without leaking filesystem errors", async () => {
    const result = await readChildTranscript("/nonexistent/private/child.jsonl");
    expect(result.text).toBe("Child transcript is not available yet.");
    expect(result.text).not.toContain("/nonexistent");
  });
});

// This component test covers focus, identity, disposal, and resize races without a provider or terminal.
describe("subagent browser interaction", () => {
  it("inspects a retained job, refreshes status, and returns without mutating the job", async () => {
    const path = await transcript(
      message("user", "Investigate") + message("assistant", "Evidence found"),
    );
    const job = {
      id: "job-1",
      name: "调查",
      status: "running",
      task: "Investigate",
      cwd: "/tmp",
      createdAt: "2026-10-07",
      latestDetails: { sessionFile: path },
      controller: new AbortController(),
    } as SubagentJob;
    const done = vi.fn();
    const requestRender = vi.fn();
    const browser = new SubagentBrowser(
      () => [job],
      { requestRender, terminal: { rows: 40 } } as any,
      theme as any,
      done,
    );
    try {
      expect(browser.render(50).join("\n")).toContain("调查");
      browser.handleInput("\r");
      await vi.waitFor(() => expect(browser.render(50).join("\n")).toContain("Evidence found"));
      job.status = "completed";
      expect(browser.render(50).join("\n")).toContain("completed");
      for (const width of [12, 40, 80]) {
        expect(browser.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
      }
      browser.handleInput("\u001b");
      expect(done).not.toHaveBeenCalled();
      expect(browser.render(50).join("\n")).toContain("调查");
      browser.handleInput("\u001b");
      expect(done).toHaveBeenCalledOnce();
      expect(job.controller.signal.aborted).toBe(false);
      expect(await readFile(path, "utf8")).toContain("Evidence found");
    } finally {
      browser.dispose();
    }
  });

  it("distinguishes repeated jobs and bounds retained failure diagnostics", async () => {
    const path = await transcript(message("assistant", "Earlier output"));
    const jobs = ["11111111-one", "22222222-two"].map((id) => ({
      id,
      name: "review",
      status: "failed",
      task: "Inspect",
      latestDetails: {
        model: "test/model",
        sessionFile: path,
        errorMessage: "\u001b]52;c;secret\u0007connection failed\n" + "x".repeat(100_000),
      },
    })) as SubagentJob[];
    const browser = new SubagentBrowser(
      () => jobs,
      { requestRender: vi.fn(), terminal: { rows: 40 } } as any,
      theme as any,
      vi.fn(),
    );
    try {
      const picker = browser.render(100).join("\n");
      expect(picker).toContain("11111111");
      expect(picker).toContain("22222222");
      browser.handleInput("\u001b[B");
      browser.handleInput("\r");
      await vi.waitFor(() => expect(browser.render(100).join("\n")).toContain("Earlier output"));
      const displayed = browser.render(100).join("\n");
      expect(displayed).toContain("22222222-two");
      expect(displayed).toContain("connection failed");
      expect(displayed).not.toMatch(/[\u0007\u001b]/);
      expect(displayed).toContain("[Diagnostic truncated.]");
    } finally {
      browser.dispose();
    }
  });

  it("fits short terminals and keeps untrusted metadata on single rows", async () => {
    const path = `${await transcript("")}\n\tname`;
    await writeFile(path, message("assistant", "last message"));
    const jobs = Array.from({ length: 8 }, (_, index) => ({
      id: String(index),
      name: `job-${index}\n\tforged`,
      status: "completed",
      latestDetails: { sessionFile: path },
      task: "task\nline",
    })) as SubagentJob[];
    const terminal = { rows: 12 };
    const browser = new SubagentBrowser(
      () => jobs,
      { requestRender: vi.fn(), terminal } as any,
      theme as any,
      vi.fn(),
    );
    try {
      browser.render(50);
      for (let index = 0; index < 7; index++) browser.handleInput("\u001b[B");
      expect(browser.render(50).join("\n")).toContain("job-7 forged");
      browser.handleInput("\r");
      await vi.waitFor(() => expect(browser.render(50).join("\n")).toContain("last message"));
      for (const rows of [5, 8, 12, 40]) {
        terminal.rows = rows;
        const rendered = browser.render(30);
        expect(rendered.length).toBeLessThanOrEqual(Math.floor(rows * 0.8));
        expect(rendered.every((line) => !/[\n\r\t]/.test(line))).toBe(true);
      }
    } finally {
      browser.dispose();
    }
  });

  it("discards a pending transcript read when its job is evicted", async () => {
    let resolveRead!: (value: { text: string; truncated: boolean }) => void;
    vi.spyOn(transcriptReader, "readChildTranscript").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    let jobs = [
      {
        id: "one",
        name: "review",
        status: "completed",
        latestDetails: { sessionFile: "/child.jsonl" },
      },
    ] as SubagentJob[];
    const browser = new SubagentBrowser(
      () => jobs,
      { requestRender: vi.fn(), terminal: { rows: 40 } } as any,
      theme as any,
      vi.fn(),
    );
    try {
      browser.handleInput("\r");
      jobs = [];
      resolveRead({ text: "stale child content", truncated: false });
      await vi.waitFor(() => expect(browser.render(80).join("\n")).toContain("no longer retained"));
      expect(browser.render(80).join("\n")).not.toContain("stale child content");
    } finally {
      browser.dispose();
    }
  });

  it("keeps completed and failed jobs searchable and stops refreshing after disposal", () => {
    vi.useFakeTimers();
    const jobs = [
      { id: "one", name: "completed-review", status: "completed" },
      { id: "two", name: "failed-audit", status: "failed" },
    ] as SubagentJob[];
    const requestRender = vi.fn();
    const browser = new SubagentBrowser(
      () => jobs,
      { requestRender, terminal: { rows: 40 } } as any,
      theme as any,
      vi.fn(),
    );
    browser.focused = true;
    browser.handleInput("failed");
    const output = browser.render(80).join("\n");
    expect(output).toContain("failed-audit");
    expect(output).not.toContain("completed-review");
    browser.dispose();
    requestRender.mockClear();
    vi.advanceTimersByTime(2_000);
    expect(requestRender).not.toHaveBeenCalled();
  });
});
