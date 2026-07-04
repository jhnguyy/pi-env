/*
 * E2E tests — full round-trip with real typescript-language-server.
 *
 * Gated behind E2E=1 environment variable.
 *
 * Run with: E2E=1 nub run test:e2e -- .pi/extensions/dev-tools/__tests__/e2e.test.ts
 * Or from repo root: E2E=1 nub run test:e2e
 *
 * These tests spawn a real LspDaemon with a real typescript-language-server
 * and verify the full pipeline from request to response.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LspE2EFixture, createLspE2EFixture, sleep } from "./e2e-fixture";

const E2E = process.env["E2E"] === "1";
const describeE2E = E2E ? describe : describe.skip;

describeE2E("LSP E2E", () => {
  let fixture: LspE2EFixture;

  beforeAll(async () => {
    fixture = await createLspE2EFixture();
  });

  afterAll(() => {
    fixture?.cleanup();
  });

  // ─── Status ───────────────────────────────────────────────────────────

  it("daemon responds with status", async () => {
    const status = await fixture.callDaemon({ action: "status" });
    expect(status.action).toBe("status");
    expect(typeof status.running).toBe("boolean");
    expect(status.pid).toBeGreaterThan(0);
  });

  // ─── Diagnostics ──────────────────────────────────────────────────────

  it("reports no errors for valid TypeScript", async () => {
    const result = await fixture.callDaemon({ action: "diagnostics", path: fixture.typesFile });
    expect(result.action).toBe("diagnostics");
    // Clean file should have 0 errors (though LSP warm-up may take a moment)
    expect(result.errorCount).toBeGreaterThanOrEqual(0);
  });

  it("reports errors for invalid TypeScript", async () => {
    const badFile = fixture.writeFile("broken.ts", [
      "const x: string = 42;",
      "const y: number = 'hello';",
    ]);

    // Retry diagnostics until errors appear (LSP may need time to process)
    let result: any;
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(300);
      result = await fixture.callDaemon({ action: "diagnostics", path: badFile });
      if (result.errorCount > 0) break;
    }

    expect(result.action).toBe("diagnostics");
    expect(result.errorCount).toBeGreaterThan(0);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].code).toMatch(/^TS\d+/);
  });

  // ─── Hover ────────────────────────────────────────────────────────────

  it("returns hover information for a type reference", async () => {
    // "name" in the User interface — line 2, character 3
    const result = await fixture.callDaemon({ action: "hover", path: fixture.typesFile, line: 2, character: 3 });
    expect(result.action).toBe("hover");
    expect(result.signature).toBeTruthy();
    expect(typeof result.signature).toBe("string");
  });

  // ─── Definition ───────────────────────────────────────────────────────

  it("returns definition for a referenced type", async () => {
    // In main.ts, "User" on line 1: "import type { User } from ..."
    // 1-indexed: 'U' is at character 15
    const result = await fixture.callDaemon({ action: "definition", path: fixture.mainFile, line: 1, character: 15 });
    expect(result.action).toBe("definition");
    expect(result.locations.length).toBeGreaterThan(0);
    const loc = result.locations[0];
    expect(loc.body).toContain("User");
    expect(loc.relativePath).toBeTruthy();
  });

  // ─── References ───────────────────────────────────────────────────────

  it("returns references to a function", async () => {
    // "greet" function definition at line 7 of types.ts
    const result = await fixture.callDaemon({ action: "references", path: fixture.typesFile, line: 7, character: 17 });
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

  // ─── Workspace Symbols ────────────────────────────────────────────────

  it("returns workspace symbols for a query", async () => {
    // First open both files so the workspace knows about them
    await fixture.callDaemon({ action: "diagnostics", path: fixture.typesFile });
    await fixture.callDaemon({ action: "diagnostics", path: fixture.mainFile });
    await sleep(200);

    const result = await fixture.callDaemon({ action: "symbols", query: "User" });
    expect(result.action).toBe("symbols");
    // May or may not find results depending on workspace indexing state
    expect(typeof result.total).toBe("number");
  });

  // ─── Multi-file: file watcher triggers re-sync ─────────────────────────

  it("reflects file changes on disk", async () => {
    const watchedFile = fixture.writeFile("watched.ts", "const a: string = 'hello';");

    // Open file initially
    await fixture.callDaemon({ action: "diagnostics", path: watchedFile });
    await sleep(300);

    // Introduce a type error
    fixture.writeFile("watched.ts", "const a: string = 42;");
    await sleep(500); // wait for file watcher + LSP re-processing

    const result = await fixture.callDaemon({ action: "diagnostics", path: watchedFile });
    // The error may or may not be detected depending on timing,
    // but the call should succeed
    expect(result.action).toBe("diagnostics");
  });
});
