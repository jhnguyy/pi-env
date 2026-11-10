import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { type TypeScriptLspFixture, createTypeScriptLspFixture } from "./e2e-fixture";

describe("LSP E2E", () => {
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
    expect(status.running).toBe(true);
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
    expect(result.errorCount).toBe(2);
    expect(result.items).toEqual([
      expect.objectContaining({
        line: 1,
        severity: "error",
        code: "TS2322",
        message: "Type 'number' is not assignable to type 'string'.",
      }),
      expect.objectContaining({
        line: 2,
        severity: "error",
        code: "TS2322",
        message: "Type 'string' is not assignable to type 'number'.",
      }),
    ]);
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

  it("reports missing Effect services, errors, and Layer inputs", async () => {
    const file = fixture.writeFile("effect-relations.ts", [
      'import { Context, type Effect, type Layer } from "effect";',
      'class MissingService extends Context.Service<MissingService, { readonly value: number }>()("MissingService") {}',
      "declare const requiring: Effect.Effect<void, never, MissingService>;",
      "export const missingContext: Effect.Effect<void> = requiring;",
      'declare const failing: Effect.Effect<void, "Failure">;',
      "export function missingError(): Effect.Effect<void> { return failing; }",
      "declare const requiringLayer: Layer.Layer<never, never, MissingService>;",
      "declare function consumeLayer(layer: Layer.Layer<never>): void;",
      "consumeLayer(requiringLayer);",
    ]);

    const result = await fixture.callDaemon({ action: "diagnostics", path: file });
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/^effect\([^)]+\)$/),
          severity: "error",
          message: expect.stringContaining("service that is missing"),
        }),
        expect.objectContaining({
          code: expect.stringMatching(/^effect\([^)]+\)$/),
          severity: "error",
          message: expect.stringContaining("expected Effect errors"),
        }),
        expect.objectContaining({
          code: expect.stringMatching(/^effect\([^)]+\)$/),
          severity: "error",
          message: expect.stringContaining("expected Layer context"),
        }),
      ]),
    );
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
    expect(result.signature).toContain("(property) User.name: string");
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
    expect(result.locations).toEqual([
      expect.objectContaining({
        absolutePath: fixture.typesFile,
        relativePath: "types.ts",
        line: 1,
        body: expect.stringContaining("export interface User {"),
      }),
    ]);
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
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          absolutePath: fixture.typesFile,
          line: 7,
          content: "export function greet(user: User): string {",
        }),
        expect.objectContaining({
          absolutePath: fixture.mainFile,
          line: 2,
          content: 'import { greet } from "./types";',
        }),
        expect.objectContaining({
          absolutePath: fixture.mainFile,
          line: 10,
          content: "console.log(greet(bob));",
        }),
      ]),
    );
    expect(result.items).toHaveLength(3);
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

    const beforeTypes = await readFile(renameFixture.typesFile, "utf8");
    const beforeMain = await readFile(renameFixture.mainFile, "utf8");
    const result = await renameFixture.callDaemon({
      action: "rename",
      path: renameFixture.typesFile,
      line: 7,
      character: 17,
      newName: "welcome",
    });

    expect(result.action).toBe("rename");
    expect(result.totalEdits).toBe(3);
    expect(result.files).toHaveLength(2);
    await expect(readFile(renameFixture.typesFile, "utf8")).resolves.toBe(
      beforeTypes.replace("function greet(", "function welcome("),
    );
    await expect(readFile(renameFixture.mainFile, "utf8")).resolves.toBe(
      beforeMain.replaceAll("greet", "welcome"),
    );
  });
});
