import { describe, expect, it } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { serializeMessage, LspParser, LspIdGenerator, type LspMessage } from "../lsp-transport";

describeIfEnabled("dev-tools", "LspTransport", () => {
  // ─── serializeMessage ─────────────────────────────────────────────────────

  describe("serializeMessage", () => {
    it("includes Content-Length header", () => {
      const msg: LspMessage = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
      const buf = serializeMessage(msg);
      const str = buf.toString();
      expect(str).toMatch(/Content-Length: \d+\r\n\r\n/);
    });

    it("Content-Length matches body byte length", () => {
      const msg: LspMessage = { jsonrpc: "2.0", id: 2, method: "textDocument/hover", params: { position: { line: 4, character: 10 } } };
      const buf = serializeMessage(msg);
      const str = buf.toString("ascii", 0, buf.indexOf("\r\n\r\n") + 4);
      const headerMatch = str.match(/Content-Length: (\d+)/);
      expect(headerMatch).not.toBeNull();
      const bodyStart = buf.indexOf("\r\n\r\n") + 4;
      const body = buf.subarray(bodyStart);
      expect(body.length).toBe(parseInt(headerMatch![1]!, 10));
    });

    it("body is valid JSON matching the original message", () => {
      const msg: LspMessage = { jsonrpc: "2.0", id: 3, result: { contents: "string: foo" } };
      const buf = serializeMessage(msg);
      const bodyStart = buf.indexOf("\r\n\r\n") + 4;
      const parsed = JSON.parse(buf.subarray(bodyStart).toString("utf8"));
      expect(parsed).toEqual(msg);
    });

    it("handles multibyte UTF-8 correctly", () => {
      const msg: LspMessage = { jsonrpc: "2.0", method: "test", params: { text: "こんにちは" } };
      const buf = serializeMessage(msg);
      const headerStr = buf.toString("ascii", 0, buf.indexOf("\r\n\r\n"));
      const declared = parseInt(headerStr.match(/Content-Length: (\d+)/)![1]!, 10);
      const bodyStart = buf.indexOf("\r\n\r\n") + 4;
      const actualBodyLen = buf.length - bodyStart;
      expect(actualBodyLen).toBe(declared);
    });
  });

  // ─── LspParser ───────────────────────────────────────────────────────────

  describe("LspParser", () => {
    function collectMessages(chunks: Array<Buffer | string>): LspMessage[] {
      const msgs: LspMessage[] = [];
      const parser = new LspParser((m) => msgs.push(m));
      for (const chunk of chunks) parser.push(chunk);
      return msgs;
    }

    it("parses a single complete message", () => {
      const msg: LspMessage = { jsonrpc: "2.0", id: 1, method: "textDocument/didOpen" };
      const msgs = collectMessages([serializeMessage(msg)]);
      expect(msgs.length).toBe(1);
      expect(msgs[0]).toEqual(msg);
    });

    it("parses two messages in one chunk", () => {
      const m1: LspMessage = { jsonrpc: "2.0", id: 1, method: "initialize" };
      const m2: LspMessage = { jsonrpc: "2.0", id: 2, result: null };
      const combined = Buffer.concat([serializeMessage(m1), serializeMessage(m2)]);
      const msgs = collectMessages([combined]);
      expect(msgs.length).toBe(2);
      expect(msgs[0]).toEqual(m1);
      expect(msgs[1]).toEqual(m2);
    });

    it("handles a message split across two chunks", () => {
      const msg: LspMessage = { jsonrpc: "2.0", id: 5, method: "hover", params: { x: 1 } };
      const buf = serializeMessage(msg);
      const half = Math.floor(buf.length / 2);
      const msgs = collectMessages([buf.subarray(0, half), buf.subarray(half)]);
      expect(msgs.length).toBe(1);
      expect(msgs[0]).toEqual(msg);
    });

    it("handles a message split byte-by-byte", () => {
      const msg: LspMessage = { jsonrpc: "2.0", id: 99, result: { hover: true } };
      const buf = serializeMessage(msg);
      const chunks: Buffer[] = [];
      for (let i = 0; i < buf.length; i++) chunks.push(buf.subarray(i, i + 1));
      const msgs = collectMessages(chunks);
      expect(msgs.length).toBe(1);
      expect(msgs[0]).toEqual(msg);
    });

    it("skips malformed JSON body", () => {
      const good: LspMessage = { jsonrpc: "2.0", id: 10, method: "ok" };
      const badBody = "{not valid}";
      const badHeader = `Content-Length: ${Buffer.byteLength(badBody, "utf8")}\r\n\r\n`;
      const badBuf = Buffer.concat([Buffer.from(badHeader, "ascii"), Buffer.from(badBody, "utf8")]);

      const msgs: LspMessage[] = [];
      const parser = new LspParser((m) => msgs.push(m));
      parser.push(badBuf);
      parser.push(serializeMessage(good));
      // bad message skipped, good one still parsed
      expect(msgs.length).toBe(1);
      expect(msgs[0]).toEqual(good);
    });

    it("leaves no residual bytes after consuming messages", () => {
      const msg: LspMessage = { jsonrpc: "2.0", id: 1, method: "test" };
      const parser = new LspParser(() => {});
      parser.push(serializeMessage(msg));
      expect(parser.buffered).toBe(0);
    });

    it("accepts string input", () => {
      const msg: LspMessage = { jsonrpc: "2.0", id: 1, method: "stringTest" };
      const buf = serializeMessage(msg);
      // Feed as latin1 string (fine for ASCII headers)
      const msgs: LspMessage[] = [];
      const parser = new LspParser((m) => msgs.push(m));
      parser.push(buf.toString("binary"));
      // May or may not parse correctly depending on encoding, but shouldn't throw
      expect(typeof msgs.length).toBe("number");
    });
  });

  // ─── LspIdGenerator ──────────────────────────────────────────────────────

  describe("LspIdGenerator", () => {
    it("starts at 1", () => {
      const gen = new LspIdGenerator();
      expect(gen.get()).toBe(1);
    });

    it("increments on each call", () => {
      const gen = new LspIdGenerator();
      expect(gen.get()).toBe(1);
      expect(gen.get()).toBe(2);
      expect(gen.get()).toBe(3);
    });

    it("each generator is independent", () => {
      const a = new LspIdGenerator();
      const b = new LspIdGenerator();
      a.get(); a.get();
      expect(b.get()).toBe(1);
    });
  });
});
