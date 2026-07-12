import { describe, expect, it } from "vitest";

import { resolveNodeCommand } from "../../../../src/process/platform";
import { LspBackend } from "../backend";

describe("LspBackend lifecycle", () => {
  it("does not publish a child after shutdown overtakes startup", async () => {
    const backend = new LspBackend({
      mode: "lsp",
      name: "typescript",
      binaryName: "test-language-server",
      binaryArgs: [],
      launchCommand: resolveNodeCommand(),
      launchArgs: ["-e", "setInterval(() => {}, 1000)"],
      extensions: new Map([[".ts", "typescript"]]),
      rootMarkers: [],
      capabilities: {},
      codePrefix: "TS",
      supportsWorkspaceSymbols: true,
    } as any);

    const startup = backend.ensureStarted();
    const shutdown = backend.shutdown();

    await shutdown;
    await expect(startup).rejects.toThrow("startup cancelled");
    expect(backend.isRunning).toBe(false);
    await backend.shutdown();
  });
});
