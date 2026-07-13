/** LSP base-protocol Content-Length framing over stdio. */

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");

export interface LspMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function serializeMessage(msg: LspMessage): Buffer {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(body, "utf8")]);
}

export class LspParser {
  private buffer: Buffer = Buffer.alloc(0);
  readonly onMessage: (msg: LspMessage) => void;

  constructor(onMessage: (msg: LspMessage) => void) {
    this.onMessage = onMessage;
  }

  push(chunk: Buffer | string): void {
    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buffer = Buffer.concat([this.buffer, data]);
    this.drain();
  }

  get buffered(): number {
    return this.buffer.length;
  }

  private drain(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd === -1) break;

      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const contentLength = parseContentLength(header);
      if (contentLength === null) {
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
        continue;
      }

      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      if (this.buffer.length < bodyStart + contentLength) break;

      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + contentLength);

      try {
        this.onMessage(JSON.parse(body) as LspMessage);
      } catch {
        // A malformed frame must not block later frames already in the buffer.
      }
    }
  }
}

function parseContentLength(header: string): number | null {
  for (const line of header.split("\r\n")) {
    if (!line.toLowerCase().startsWith("content-length:")) continue;
    const value = parseInt(line.slice("content-length:".length).trim(), 10);
    return isNaN(value) || value < 0 ? null : value;
  }
  return null;
}
