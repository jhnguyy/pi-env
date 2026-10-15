import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveEffectiveCwd, ResolutionResultTag, ResolutionErrorReason } from "../resolver";
// Invalid paths must fail before native child initialization.
describe("subagent cwd validation", () => {
  it("validates and canonicalizes only explicit cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-cwd-"));
    try {
      const ok = resolveEffectiveCwd({ task: "x", cwd: dir }, "/missing/default");
      expect(ok._tag).toBe(ResolutionResultTag.Ok);
      if (ok._tag === ResolutionResultTag.Ok) expect(ok.value).toBe(realpathSync(dir));
      const relative = resolveEffectiveCwd({ task: "x", cwd: "relative" }, dir);
      expect(relative._tag).toBe(ResolutionResultTag.Error);
      if (relative._tag === ResolutionResultTag.Error)
        expect(relative.error.reason).toBe(ResolutionErrorReason.InvalidCwd);
      const file = join(dir, "file");
      writeFileSync(file, "x");
      const notDir = resolveEffectiveCwd({ task: "x", cwd: file }, dir);
      expect(notDir._tag).toBe(ResolutionResultTag.Error);
      const implicit = resolveEffectiveCwd({ task: "x" }, "/missing/default");
      expect(implicit).toEqual({ _tag: ResolutionResultTag.Ok, value: "/missing/default" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
