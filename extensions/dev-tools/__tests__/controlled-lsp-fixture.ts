import { appendFileSync } from "node:fs";
import type { LspMessage } from "../lsp-transport";

interface Message {
  id?: number;
  method?: string;
  params?: unknown;
}

const countFile = process.argv[2];
if (countFile) appendFileSync(countFile, `${process.pid}\n`);
let buffer = Buffer.alloc(0);
function send(message: LspMessage): void {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const split = buffer.indexOf("\r\n\r\n");
    if (split < 0) return;
    const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, split).toString("ascii"));
    if (!match) process.exit(2);
    const end = split + 4 + Number(match[1]);
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.subarray(split + 4, end).toString("utf8")) as Message;
    buffer = buffer.subarray(end);
    if (message.method === "fixture/publishDiagnostics") {
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: message.params });
    }
    if (message.id !== undefined) {
      if (message.method === "textDocument/hover") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "unsupported hover" },
        });
      } else {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: message.method === "initialize" ? { capabilities: {} } : null,
        });
      }
    }
    if (message.method === "exit") process.exit(0);
  }
});
