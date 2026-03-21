/**
 * Security extension — two concerns, no interaction required:
 *
 *   1. tool_call  → hard-block a small set of genuinely dangerous operations
 *   2. tool_result → redact sensitive file contents before they reach the model
 *
 * No prompts. No rule engine. No session modes. Block means block.
 */

import type { ExtensionAPI, ToolCallEventResult } from "@mariozechner/pi-coding-agent";
import { BLOCKLIST } from "./blocklist";
import { CredentialScanner } from "./credential-scanner";

export default function (pi: ExtensionAPI) {
  const scanner = new CredentialScanner();

  // ── Hard block dangerous operations ────────────────────────────────────────

  pi.on("tool_call", async (event) => {
    const input = event.input as Record<string, string>;

    for (const entry of BLOCKLIST) {
      if (!entry.tools.includes(event.toolName)) continue;
      const value = input[entry.field] ?? "";
      if (entry.pattern.test(value)) {
        return { block: true, reason: entry.reason } satisfies ToolCallEventResult;
      }
    }
  });

  // ── Redact sensitive file reads before content reaches the model ───────────
  //
  // Returning { content } from tool_result replaces what gets sent to the model.
  // This prevents key material (tokens, secrets, SSH keys) from being serialized
  // into session history and re-sent on every API request.

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "read") return undefined;

    const path = (event.input as Record<string, unknown>)?.path;
    if (typeof path !== "string") return undefined;

    if (!scanner.isSensitiveFileName(path)) return undefined;

    const filename = path.split("/").pop() ?? path;
    return {
      content: [
        {
          type: "text" as const,
          text: `[${filename} redacted — edit the file directly to modify]`,
        },
      ],
    };
  });
}
