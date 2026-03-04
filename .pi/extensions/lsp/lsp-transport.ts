/**
 * LSP JSON-RPC framing — Content-Length header protocol over stdio.
 *
 * LSP uses the "base protocol" from Language Server Protocol spec:
 *   Content-Length: <n>\r\n
 *   \r\n
 *   <n bytes of JSON body>
 *
 * This module handles:
 *   - Serializing outgoing LSP messages
 *   - Buffering and parsing incoming chunked data
 */

// ─── LSP Message Types ───────────────────────────────────────────────────────

export interface LspMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Serialization ────────────────────────────────────────────────────────────

/** Serialize an LSP message to its wire format with Content-Length header. */
export function serializeMessage(msg: LspMessage): Buffer {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(body, "utf8")]);
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Incremental LSP message parser.
 * Feed chunks of data via `push()`. Parsed messages are emitted via `onMessage`.
 */
export class LspParser {
  private buffer: Buffer = Buffer.alloc(0);
  readonly onMessage: (msg: LspMessage) => void;

  constructor(onMessage: (msg: LspMessage) => void) {
    this.onMessage = onMessage;
  }

  /** Feed a chunk of data into the parser. May emit 0, 1, or more messages. */
  push(chunk: Buffer | string): void {
    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buffer = Buffer.concat([this.buffer, data]);
    this.drain();
  }

  /** Returns how many bytes are currently buffered (useful for tests). */
  get buffered(): number {
    return this.buffer.length;
  }

  private drain(): void {
    while (true) {
      // Find the end of the header block (CRLFCRLF)
      const headerEnd = this.findHeaderEnd();
      if (headerEnd === -1) break; // incomplete header

      const headerStr = this.buffer.subarray(0, headerEnd).toString("ascii");
      const contentLength = parseContentLength(headerStr);
      if (contentLength === null) {
        // Malformed header — skip past the separator and try again
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      // Check if we have the full body
      const bodyStart = headerEnd + 4; // 4 = \r\n\r\n
      if (this.buffer.length < bodyStart + contentLength) break; // incomplete body

      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + contentLength);

      try {
        const msg = JSON.parse(body) as LspMessage;
        this.onMessage(msg);
      } catch {
        // Skip malformed JSON, continue parsing
      }
    }
  }

  /** Find the index of the start of the \r\n\r\n separator, returns -1 if not found. */
  private findHeaderEnd(): number {
    for (let i = 0; i < this.buffer.length - 3; i++) {
      if (
        this.buffer[i] === 0x0d && // \r
        this.buffer[i + 1] === 0x0a && // \n
        this.buffer[i + 2] === 0x0d && // \r
        this.buffer[i + 3] === 0x0a    // \n
      ) {
        return i;
      }
    }
    return -1;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract Content-Length value from header string. Returns null if not found. */
function parseContentLength(header: string): number | null {
  const lines = header.split("\r\n");
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith("content-length:")) {
      const value = parseInt(line.slice("content-length:".length).trim(), 10);
      return isNaN(value) || value < 0 ? null : value;
    }
  }
  return null;
}

// ─── ID counter ───────────────────────────────────────────────────────────────

/** Simple incrementing LSP message ID generator. */
export class LspIdGenerator {
  private next = 1;
  get(): number {
    return this.next++;
  }
}
