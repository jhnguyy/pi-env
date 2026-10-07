import { open } from "node:fs/promises";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { Effect } from "effect";

export const TRANSCRIPT_READ_BYTES = 128 * 1024;
const DISPLAY_CHARACTERS = 32 * 1024;

export interface ChildTranscript {
  readonly text: string;
  readonly truncated: boolean;
}

export function plainChildText(text: string): string {
  return stripTerminalSequences(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block: unknown) => {
      if (!record(block)) return [];
      if (block.type === "text" && typeof block.text === "string") return [block.text];
      if (block.type === "toolCall" && typeof block.name === "string")
        return [`Tool: ${block.name}`];
      return [];
    })
    .join("\n");
}

function transcriptText(raw: string, omittedHistory: boolean): ChildTranscript {
  const messages: string[] = [];
  // Child runs are append-only. This bounded viewer is not a general session-branch reader.
  for (const entry of parseSessionEntries(raw) as unknown[]) {
    if (!record(entry) || entry.type !== "message" || !record(entry.message)) continue;
    const message = entry.message;
    if (!["user", "assistant", "toolResult"].includes(String(message.role))) continue;
    const label =
      message.role === "toolResult"
        ? `Tool result: ${typeof message.toolName === "string" ? message.toolName : "unknown"}`
        : String(message.role);
    const text = plainChildText(contentText(message.content));
    if (text) messages.push(`${plainChildText(label)}\n${text}`);
  }
  const text = messages.join("\n\n");
  const truncated = omittedHistory || text.length > DISPLAY_CHARACTERS;
  return {
    text:
      (truncated ? "[Earlier transcript content omitted.]\n\n" : "") +
      (text.slice(-DISPLAY_CHARACTERS) || "No finalized child messages yet."),
    truncated,
  };
}

export function readChildTranscript(path: string): Promise<ChildTranscript> {
  const unavailable = { text: "Child transcript is not available yet.", truncated: false };
  return Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.tryPromise(() => open(path, "r")),
      (file) =>
        Effect.tryPromise(async () => {
          const stat = await file.stat();
          if (!stat.isFile()) return unavailable;
          const start = Math.max(0, stat.size - TRANSCRIPT_READ_BYTES);
          const buffer = Buffer.alloc(Math.min(stat.size, TRANSCRIPT_READ_BYTES));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
          const raw = buffer.subarray(0, bytesRead).toString("utf8");
          const firstLineEnd = raw.indexOf("\n");
          const complete = start === 0 ? raw : firstLineEnd < 0 ? "" : raw.slice(firstLineEnd + 1);
          return transcriptText(complete, start > 0);
        }),
      (file) => Effect.promise(() => file.close()),
    ).pipe(Effect.catch(() => Effect.succeed(unavailable))),
  );
}
