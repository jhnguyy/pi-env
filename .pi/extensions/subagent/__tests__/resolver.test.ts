import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Resolver from "../resolver";
// Invalid paths must fail before native child initialization.
describe("subagent cwd validation", () => {
  it("validates and canonicalizes only explicit cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-cwd-"));
    try {
      const ok = Resolver.resolveEffectiveCwd({ task: "x", cwd: dir }, "/missing/default");
      expect(ok._tag).toBe(Resolver.ResolutionResultTag.Ok);
      if (ok._tag === Resolver.ResolutionResultTag.Ok) expect(ok.value).toBe(realpathSync(dir));
      const relative = Resolver.resolveEffectiveCwd({ task: "x", cwd: "relative" }, dir);
      expect(relative._tag).toBe(Resolver.ResolutionResultTag.Error);
      if (relative._tag === Resolver.ResolutionResultTag.Error)
        expect(relative.error.reason).toBe(Resolver.ResolutionErrorReason.InvalidCwd);
      const file = join(dir, "file");
      writeFileSync(file, "x");
      const notDir = Resolver.resolveEffectiveCwd({ task: "x", cwd: file }, dir);
      expect(notDir._tag).toBe(Resolver.ResolutionResultTag.Error);
      const implicit = Resolver.resolveEffectiveCwd({ task: "x" }, "/missing/default");
      expect(implicit).toEqual({ _tag: Resolver.ResolutionResultTag.Ok, value: "/missing/default" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
