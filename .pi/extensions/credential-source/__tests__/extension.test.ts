import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import credentialSourceExtension from "../index";
import { resetCredentialSourceRegistryForTests } from "../../_shared/credential-source";

describe("credential source extension boundary", () => {
  beforeEach(() => resetCredentialSourceRegistryForTests());

  it("registers lifecycle handlers without exposing a model-facing tool", () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    } as any;

    credentialSourceExtension(pi);

    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(pi.registerCommand).not.toHaveBeenCalled();
  });

  it("fails session startup when settings cannot establish the credential boundary", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    } as any;
    credentialSourceExtension(pi);
    const notify = vi.fn();

    const cwd = mkdtempSync(join(tmpdir(), "credential-source-settings-"));
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ credentialSource: { entries: {} } }),
    );

    await expect(
      handlers.get("session_start")?.(
        {},
        {
          cwd,
          hasUI: false,
          ui: { notify },
        },
      ),
    ).rejects.toBeDefined();
    expect(notify).toHaveBeenCalledWith(
      "Project settings cannot define credentialSource. Remove that block and reload Pi.",
      "error",
    );
  });
});
