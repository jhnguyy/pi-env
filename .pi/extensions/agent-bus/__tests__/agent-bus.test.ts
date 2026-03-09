import { expect, it, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { FsTransport } from "../transport";
import { BusClient } from "../bus-client";
import type { BusConfig } from "../types";
import { BusError, CHANNEL_PATTERN } from "../types";
import extensionFactory from "../index";
import { initBusService } from "../bus-service";

// ─── Helpers ─────────────────────────────────────────────────

function makeClient(agentId: string, sessionId: string | null = null): BusClient {
  const transport = new FsTransport();
  const config: BusConfig = { agentId, sessionId };
  return new BusClient(transport, config);
}

// ─── Tests ───────────────────────────────────────────────────

describeIfEnabled("agent-bus", "FsTransport", () => {
  let transport: FsTransport;
  let sessionId: string;

  beforeEach(() => {
    transport = new FsTransport();
    sessionId = `test-${Date.now()}`;
    transport.ensureSession(sessionId);
  });

  afterEach(() => {
    rmSync(`/tmp/pi-bus-${sessionId}`, { recursive: true, force: true });
  });

  it("sessionExists returns false before creation", () => {
    expect(transport.sessionExists("nonexistent-session")).toBe(false);
  });

  it("sessionExists returns true after ensureSession", () => {
    expect(transport.sessionExists(sessionId)).toBe(true);
  });

  it("ensureSession is idempotent", () => {
    transport.ensureSession(sessionId); // second call
    expect(transport.sessionExists(sessionId)).toBe(true);
  });

  it("publish and readMessages roundtrip", () => {
    const msg = {
      channel: "test",
      sender: "agent-a",
      timestamp: Date.now() - 1,
      type: "status" as const,
      message: "hello",
    };
    transport.publish(sessionId, "test", msg);
    const msgs = transport.readMessages(sessionId, "test", 0);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toBe("hello");
    expect(msgs[0].sender).toBe("agent-a");
  });

  it("readMessages excludes messages at or before since", () => {
    const ts = Date.now();
    transport.publish(sessionId, "ch", {
      channel: "ch", sender: "a", timestamp: ts - 1, type: "status", message: "old",
    });
    const msgs = transport.readMessages(sessionId, "ch", ts - 1);
    expect(msgs).toHaveLength(0); // strict >
  });

  it("countMessages matches readMessages length", () => {
    const since = Date.now() - 1;
    transport.publish(sessionId, "ch", {
      channel: "ch", sender: "a", timestamp: Date.now(), type: "status", message: "m1",
    });
    transport.publish(sessionId, "ch", {
      channel: "ch", sender: "a", timestamp: Date.now(), type: "status", message: "m2",
    });
    const count = transport.countMessages(sessionId, "ch", since);
    const msgs = transport.readMessages(sessionId, "ch", since);
    expect(count).toBe(msgs.length);
  });

  it("getChannels lists channels that have messages", () => {
    transport.publish(sessionId, "alpha", {
      channel: "alpha", sender: "a", timestamp: Date.now(), type: "status", message: "x",
    });
    transport.publish(sessionId, "beta", {
      channel: "beta", sender: "a", timestamp: Date.now(), type: "status", message: "y",
    });
    const channels = transport.getChannels(sessionId);
    expect(channels).toContain("alpha");
    expect(channels).toContain("beta");
  });

  it("cursor roundtrip (read/update)", () => {
    const cursor = transport.readCursor(sessionId, "agent-a");
    expect(cursor).toEqual({});

    transport.updateCursor(sessionId, "agent-a", { test: 1000 });
    const updated = transport.readCursor(sessionId, "agent-a");
    expect(updated.test).toBe(1000);
  });

  it("updateCursor merges (max wins, never rewinds)", () => {
    transport.updateCursor(sessionId, "a", { ch: 500 });
    transport.updateCursor(sessionId, "a", { ch: 200 }); // lower — should not rewind
    const cursor = transport.readCursor(sessionId, "a");
    expect(cursor.ch).toBe(500);
  });

  it("sanitizes agentId with special chars in cursor filename", () => {
    // Should not throw
    transport.updateCursor(sessionId, "agent/with:special chars!", { test: 1 });
    const cursor = transport.readCursor(sessionId, "agent/with:special chars!");
    expect(cursor.test).toBe(1);
  });
});

describeIfEnabled("agent-bus", "BusClient", () => {
  let orch: BusClient;
  let worker: BusClient;
  let sessionId: string;

  beforeEach(() => {
    orch = makeClient("orch");
    sessionId = orch.start();
    worker = makeClient("worker", sessionId);
  });

  afterEach(() => {
    rmSync(`/tmp/pi-bus-${sessionId}`, { recursive: true, force: true });
    // Clean up env side-effects
    delete process.env.PI_BUS_SESSION;
    delete process.env.PI_AGENT_ID;
  });

  // ─── start ───────────────────────────────────────────────────

  it("start generates a session ID and sets env", () => {
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(0);
    expect(process.env.PI_BUS_SESSION).toBe(sessionId);
  });

  it("start is idempotent for same session", () => {
    const sid2 = orch.start(sessionId);
    expect(sid2).toBe(sessionId);
  });

  it("start throws SESSION_CONFLICT for different session", () => {
    expect(() => orch.start("different-id")).toThrow(BusError);
    try { orch.start("different-id"); } catch (e) {
      expect((e as BusError).code).toBe("SESSION_CONFLICT");
    }
  });

  it("start accepts agentId and sets PI_AGENT_ID", () => {
    delete process.env.PI_AGENT_ID;
    const transport = new FsTransport();
    const fresh = new BusClient(transport, { agentId: null, sessionId: null });
    const sid = fresh.start(undefined, "test-agent");
    expect(process.env.PI_AGENT_ID).toBe("test-agent");
    rmSync(`/tmp/pi-bus-${sid}`, { recursive: true, force: true });
  });

  // ─── subscribe ───────────────────────────────────────────────

  it("subscribe registers channels (cursor = now-1)", () => {
    orch.subscribe(["alpha", "beta"]);
    const transport = new FsTransport();
    const cursor = transport.readCursor(sessionId, "orch");
    expect(Object.keys(cursor)).toContain("alpha");
    expect(Object.keys(cursor)).toContain("beta");
    // cursor should be near now (within 50ms of now-1)
    const approxNow = Date.now();
    expect(cursor.alpha).toBeGreaterThan(approxNow - 100);
    expect(cursor.alpha).toBeLessThan(approxNow + 10);
  });

  it("subscribe is additive (does not reset existing channels)", () => {
    orch.subscribe(["ch1"]);
    const transport = new FsTransport();
    const before = transport.readCursor(sessionId, "orch").ch1;
    // Publish a message and read it to advance cursor
    worker.publish("ch1", "msg");
    orch.read("ch1");
    const afterRead = transport.readCursor(sessionId, "orch").ch1;
    // Now re-subscribe — ch1 cursor should NOT reset
    orch.subscribe(["ch1", "ch2"]);
    const afterResub = transport.readCursor(sessionId, "orch").ch1;
    expect(afterResub).toBe(afterRead); // unchanged
    expect(afterResub).toBeGreaterThan(before);
  });

  it("subscribe throws on invalid channel", () => {
    expect(() => orch.subscribe(["INVALID CHANNEL"])).toThrow(BusError);
  });

  // ─── publish ─────────────────────────────────────────────────

  it("publish writes a readable message", () => {
    worker.publish("results", "task done", "result", { score: 42 });
    orch.subscribe(["results"]);
    // Use transport directly to read raw (bypass cursor)
    const transport = new FsTransport();
    const msgs = transport.readMessages(sessionId, "results", 0);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toBe("task done");
    expect(msgs[0].type).toBe("result");
    expect(msgs[0].data?.score).toBe(42);
    expect(msgs[0].sender).toBe("worker");
  });

  it("publish throws on invalid channel", () => {
    expect(() => worker.publish("INVALID!", "msg")).toThrow(BusError);
  });

  it("publish throws without agent ID", () => {
    const noId = new BusClient(new FsTransport(), { agentId: null, sessionId });
    expect(() => noId.publish("ch", "msg")).toThrow(BusError);
    try { noId.publish("ch", "msg"); } catch(e) {
      expect((e as BusError).code).toBe("NO_AGENT_ID");
    }
  });

  // ─── check ───────────────────────────────────────────────────

  it("check returns counts for new messages", () => {
    orch.subscribe(["test"]);
    worker.publish("test", "hello");
    const counts = orch.check();
    expect(counts["test"]).toBe(1);
  });

  it("check returns empty when no new messages", () => {
    orch.subscribe(["test"]);
    const counts = orch.check();
    expect(Object.keys(counts)).toHaveLength(0);
  });

  // ─── read ────────────────────────────────────────────────────

  it("read returns messages and advances cursor", () => {
    orch.subscribe(["results"]);
    worker.publish("results", "msg-1");
    worker.publish("results", "msg-2");

    const msgs = orch.read("results");
    expect(msgs).toHaveLength(2);

    // Second read: cursor advanced, no new messages
    const msgs2 = orch.read("results");
    expect(msgs2).toHaveLength(0);
  });

  it("read with implicit subscribe sees all history", () => {
    // Publish before subscribe
    worker.publish("events", "historic");
    const msgs = orch.read("events"); // implicit subscribe at 0
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toBe("historic");
  });

  // ─── wait ────────────────────────────────────────────────────

  it("wait returns messages published after call starts", async () => {
    const waitPromise = orch.wait(["signals"], 5);
    // Publish after wait has started (cursor baseline set)
    worker.publish("signals", "go");
    const result = await waitPromise;
    expect(result.timedOut).toBe(false);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages[0].message).toBe("go");
  });

  it("wait times out when no messages arrive", async () => {
    const result = await orch.wait(["empty"], 0.3); // 300ms
    expect(result.timedOut).toBe(true);
    expect(result.messages).toHaveLength(0);
  });

  it("wait aborts on AbortSignal", async () => {
    const ac = new AbortController();
    const waitPromise = orch.wait(["ch"], 10, ac.signal);
    setTimeout(() => ac.abort(), 100);
    const result = await waitPromise;
    expect(result.timedOut).toBe(true); // abort treated as timeout
  });

  // ─── formatMessages ──────────────────────────────────────────

  it("formatMessages produces [sender HH:MM:SS] message format", () => {
    worker.publish("test", "hello world");
    const msgs = orch.read("test");
    const formatted = orch.formatMessages(msgs);
    expect(formatted).toMatch(/^\[worker \d{2}:\d{2}:\d{2}\] hello world$/);
  });

  it("formatMessages includes data as JSON when present", () => {
    worker.publish("test", "msg", "result", { x: 1 });
    const msgs = orch.read("test");
    const formatted = orch.formatMessages(msgs);
    expect(formatted).toContain('{"x":1}');
  });
});

describeIfEnabled("agent-bus", "CHANNEL_PATTERN", () => {
  it("accepts valid channels", () => {
    for (const ch of ["status", "results", "agent:worker-1", "a1", "review"]) {
      expect(CHANNEL_PATTERN.test(ch)).toBe(true);
    }
  });

  it("rejects invalid channels", () => {
    for (const ch of ["", "UPPER", "has space", "!bang", "-leading-dash"]) {
      expect(CHANNEL_PATTERN.test(ch)).toBe(false);
    }
  });
});

// ─── agent_end hook ──────────────────────────────────────────
//
// Tests for the auto-publish-on-agent_end feature.
// Strategy: invoke the extension factory with a minimal mock pi that captures
// registered event handlers, then fire them directly and inspect the published
// message via the real FsTransport (same singleton the hook uses internally).
//
// Singleton note: initBusService() caches config.sessionId at first-call time.
// We use beforeAll/afterAll with a single long-lived session so the singleton
// never points to a deleted session between tests.

describeIfEnabled("agent-bus", "agent_end hook", () => {
  let sessionId: string;
  let transport: FsTransport;

  /**
   * Minimal mock of ExtensionAPI — captures `on` handlers and no-ops `registerTool`.
   * Returns the mock and a helper to retrieve captured handlers.
   */
  function makeMockPi() {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const mockPi = {
      on(event: string, fn: (...args: unknown[]) => unknown) {
        handlers[event] = fn;
      },
      // Extension also calls registerTool — no-op it
      registerTool() {},
    } as unknown as Parameters<typeof extensionFactory>[0];
    return { mockPi, getHandler: (event: string) => handlers[event] };
  }

  // Use a single session across all hook tests.
  // This ensures the bus singleton's cached sessionId stays valid for
  // every test — we only clean up in afterAll.
  beforeAll(() => {
    transport = new FsTransport();
    sessionId = `agehook-${Date.now()}`;
    transport.ensureSession(sessionId);
    process.env.PI_BUS_SESSION = sessionId;
    process.env.PI_AGENT_ID = "test-worker";
    // Pin singleton to this session before any test fires extensionFactory
    initBusService();
  });

  afterAll(() => {
    transport.deleteSession(sessionId);
    delete process.env.PI_BUS_SESSION;
    delete process.env.PI_AGENT_ID;
    delete process.env.ORCH_BUS_CHANNEL;
  });

  beforeEach(() => {
    delete process.env.ORCH_BUS_CHANNEL;
  });

  it("publishes to ORCH_BUS_CHANNEL when set on agent_end", async () => {
    process.env.ORCH_BUS_CHANNEL = "workers:foo";
    const since = Date.now() - 1;
    const { mockPi, getHandler } = makeMockPi();
    extensionFactory(mockPi);

    const handler = getHandler("agent_end");
    expect(handler).toBeDefined();
    await handler({ type: "agent_end", messages: [] }, {} as never);

    const msgs = transport.readMessages(sessionId, "workers:foo", since);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toBe("agent_end");
    expect(msgs[0].sender).toBe("test-worker");
    expect(msgs[0].data?.signal).toBe("agent_end");
  });

  it("does not publish when ORCH_BUS_CHANNEL is not set", async () => {
    // ORCH_BUS_CHANNEL not set (cleared in beforeEach)
    const since = Date.now() - 1;
    const { mockPi, getHandler } = makeMockPi();
    extensionFactory(mockPi);

    const handler = getHandler("agent_end");
    await handler({ type: "agent_end", messages: [] }, {} as never);

    // Use a dedicated channel that should never have been written to
    const msgs = transport.readMessages(sessionId, "workers:nopub", since);
    expect(msgs).toHaveLength(0);
  });

  it("guards against double-publish on repeated agent_end fires", async () => {
    process.env.ORCH_BUS_CHANNEL = "workers:bar";
    const since = Date.now() - 1;
    const { mockPi, getHandler } = makeMockPi();
    extensionFactory(mockPi);

    const handler = getHandler("agent_end");
    // Fire twice — only one publish should land (hasPublished guard)
    await handler({ type: "agent_end", messages: [] }, {} as never);
    await handler({ type: "agent_end", messages: [] }, {} as never);

    const msgs = transport.readMessages(sessionId, "workers:bar", since);
    expect(msgs).toHaveLength(1);
  });
});
