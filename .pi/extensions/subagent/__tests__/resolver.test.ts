import { realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Resolver from "../resolver";
import * as TempDir from "../../../../src/testing/temp-dir";
// Invalid paths must fail before native child initialization.
describe("subagent cwd validation", () => {
  it("canonicalizes explicit and implicit cwd, validating only explicit paths", () => {
    const dir = TempDir.forTestSync("pi-subagent-cwd-");
    const alias = join(dir, "alias");
    symlinkSync(dir, alias, "dir");
    const ok = Resolver.resolveEffectiveCwd({ task: "x", cwd: alias }, "/missing/default");
    expect(ok._tag).toBe(Resolver.ResolutionResultTag.Ok);
    if (ok._tag === Resolver.ResolutionResultTag.Ok) expect(ok.value).toBe(realpathSync(dir));
    expect(Resolver.resolveEffectiveCwd({ task: "x" }, alias)).toEqual({
      _tag: Resolver.ResolutionResultTag.Ok,
      value: realpathSync(dir),
    });
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
  });
});
