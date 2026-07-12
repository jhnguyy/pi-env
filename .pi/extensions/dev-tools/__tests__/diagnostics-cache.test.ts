import { describe, expect, it } from "vitest";
import { DiagnosticsCache } from "../diagnostics-cache";
import type { DiagnosticItem } from "../protocol";

const effectDiagnostic: DiagnosticItem = {
  line: 2,
  character: 1,
  severity: "error",
  code: "TS3",
  message: "effect(floatingEffect)",
};

describe("DiagnosticsCache", () => {
  it("waits past the initial syntax publication for semantic plugin diagnostics", async () => {
    const cache = new DiagnosticsCache();
    const waiting = cache.waitForSettled("file:///effect.ts", 10, 100);

    cache.publish("file:///effect.ts", []);
    setTimeout(() => cache.publish("file:///effect.ts", [effectDiagnostic]), 5);

    await waiting;
    expect(cache.get("file:///effect.ts")).toEqual([effectDiagnostic]);
  });

  it("invalidates cached diagnostics when a document changes", () => {
    const cache = new DiagnosticsCache();
    cache.publish("file:///effect.ts", [effectDiagnostic]);

    cache.delete("file:///effect.ts");

    expect(cache.has("file:///effect.ts")).toBe(false);
    expect(cache.get("file:///effect.ts")).toEqual([]);
  });
});
