/**
 * Security extension — redact sensitive file contents before they reach the model.
 *
 * Intercepts tool_result for the read tool: if the file path matches a known
 * sensitive file name (.env, auth.json, etc.), replace the content with a
 * redaction notice. This prevents key material from being serialized into
 * session history and re-sent to the provider on every API request.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CredentialScanner } from "./credential-scanner";

export default function (pi: ExtensionAPI) {
  const scanner = new CredentialScanner();

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
