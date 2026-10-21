/*
 * E2E tests — full round-trip with real typescript-language-server.
 *
 * Gated behind E2E=1 environment variable.
 *
 * Run with: nub run test:e2e .pi/extensions/dev-tools/__tests__/e2e.test.ts
 * Or from repo root: E2E=1 nub run test:e2e
 *
 * These tests spawn a real LspDaemon with a real typescript-language-server
 * and verify the full pipeline from request to response.
 */

import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { type TypeScriptLspFixture, createTypeScriptLspFixture } from "./e2e-fixture";

const E2E = process.env["E2E"] === "1";
const describeE2E = E2E ? describe : describe.skip;

describeE2E("LSP E2E", () => {
  let fixture: TypeScriptLspFixture;

  beforeAll(async () => {
    fixture = createTypeScriptLspFixture();
    await fixture.start();
  });

  afterAll(async () => {
    await fixture?.cleanup();
  });

  // ─── Status ───────────────────────────────────────────────────────────

  it("daemon responds with status", async () => {
    const status = await fixture.callDaemon({ action: "status" });
    expect(status.action).toBe("status");
    expect(typeof status.running).toBe("boolean");
    expect(status.pid).toBeGreaterThan(0);
  });

  // ─── Diagnostics ──────────────────────────────────────────────────────

  it("reports errors for invalid TypeScript", async () => {
    const badFile = fixture.writeFile("broken.ts", [
      "const x: string = 42;",
      "const y: number = 'hello';",
    ]);

    const result = await fixture.callDaemon({ action: "diagnostics", path: badFile });
    expect(result.action).toBe("diagnostics");
    expect(result.errorCount).toBeGreaterThan(0);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].code).toMatch(/^TS\d+/);
  });

  it("reports Effect diagnostics with Effect identity", async () => {
    const result = await fixture.callDaemon({ action: "diagnostics", path: fixture.effectFile });
    expect(result.action).toBe("diagnostics");
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/^effect\([^)]+\)$/),
          message: expect.stringContaining("neither yielded nor used in an assignment"),
        }),
      ]),
    );
    expect(result.items.some((item: any) => item.code.startsWith("TSeffect"))).toBe(false);
  });

  // ─── Hover ────────────────────────────────────────────────────────────

  it("returns hover information for a type reference", async () => {
    // "name" in the User interface — line 2, character 3
    const result = await fixture.callDaemon({
      action: "hover",
      path: fixture.typesFile,
      line: 2,
      character: 3,
    });
    expect(result.action).toBe("hover");
    expect(result.signature).toBeTruthy();
    expect(typeof result.signature).toBe("string");
  });

  // ─── Definition ───────────────────────────────────────────────────────

  it("returns definition for a referenced type", async () => {
    // In main.ts, "User" on line 1: "import type { User } from ..."
    // 1-indexed: 'U' is at character 15
    const result = await fixture.callDaemon({
      action: "definition",
      path: fixture.mainFile,
      line: 1,
      character: 15,
    });
    expect(result.action).toBe("definition");
    expect(result.locations.length).toBeGreaterThan(0);
    const loc = result.locations[0];
    expect(loc.body).toContain("User");
    expect(loc.relativePath).toBeTruthy();
  });

  // ─── References ───────────────────────────────────────────────────────

  it("returns references to a function", async () => {
    // "greet" function definition at line 7 of types.ts
    const result = await fixture.callDaemon({
      action: "references",
      path: fixture.typesFile,
      line: 7,
      character: 17,
    });
    expect(result.action).toBe("references");
    expect(result.total).toBeGreaterThan(0);
    expect(result.items.length).toBeGreaterThan(0);
  });

  // ─── Document Symbols ─────────────────────────────────────────────────

  it("returns document symbols for a file", async () => {
    const result = await fixture.callDaemon({ action: "symbols", path: fixture.typesFile });
    expect(result.action).toBe("symbols");
    expect(result.total).toBeGreaterThan(0);
    const names = result.items.map((s: any) => s.name);
    expect(names).toContain("User");
    expect(names).toContain("greet");
  });

  // ─── Rename ────────────────────────────────────────────────────────────

  it("renames a TypeScript symbol across files", async () => {
    const renameFixture = createTypeScriptLspFixture();
    onTestFinished(() => renameFixture.cleanup());
    await renameFixture.start();

    const result = await renameFixture.callDaemon({
      action: "rename",
      path: renameFixture.typesFile,
      line: 7,
      character: 17,
      newName: "welcome",
    });

    expect(result.action).toBe("rename");
    expect(result.totalEdits).toBeGreaterThanOrEqual(3);
    expect(result.files).toHaveLength(2);
    await expect(readFile(renameFixture.typesFile, "utf8")).resolves.toContain("export function welcome");
    const mainContent = await readFile(renameFixture.mainFile, "utf8");
    expect(mainContent).toContain("import { welcome }");
    expect(mainContent).toContain("welcome(bob)");
  });
});
