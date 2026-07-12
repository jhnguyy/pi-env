import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  cleanupTempScript,
  createTempScript,
  PtcExecutionPhase,
  resolvePtcNodeCommand,
  type PtcNodeRuntime,
} from "../node-runtime";

function fakeRuntime(overrides: Partial<PtcNodeRuntime> = {}): PtcNodeRuntime {
  return {
    tmpdir: () => "/tmp",
    writeFile: () => {},
    unlink: () => {},
    ...overrides,
  };
}

describe("ptc node runtime", () => {
  it("writes temp scripts with private file permissions", async () => {
    const writes: Array<{ path: string; data: string; mode: number }> = [];

    const path = await Effect.runPromise(createTempScript("console.log(1)", fakeRuntime({
      writeFile: (filePath, data, options) => {
        writes.push({ path: filePath, data, mode: options.mode });
      },
    })));

    expect(path).toMatch(/^\/tmp\/ptc-[a-z0-9]+\.mjs$/);
    expect(writes).toEqual([{ path, data: "console.log(1)", mode: 0o600 }]);
  });

  it("maps temp script write failures to prepare errors", async () => {
    const result = await Effect.runPromise(Effect.result(createTempScript("", fakeRuntime({
      writeFile: () => { throw new Error("disk full"); },
    }))));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.phase).toBe(PtcExecutionPhase.Prepare);
      expect(result.failure.message).toBe("PTC prepare failed: disk full");
    }
  });

  it("treats cleanup unlink failures as best-effort", async () => {
    await expect(Effect.runPromise(cleanupTempScript("/tmp/missing", fakeRuntime({
      unlink: () => { throw new Error("already gone"); },
    })))).resolves.toBeUndefined();
  });

  it("uses process.execPath when PI_ENV_NODE_BIN is empty", () => {
    expect(resolvePtcNodeCommand({ PI_ENV_NODE_BIN: "" }, "/nix/store/ld-linux-x86-64.so.2")).toBe("/nix/store/ld-linux-x86-64.so.2");
  });

  it("uses PI_ENV_NODE_BIN when present, including ld-linux execPath launchers", () => {
    expect(resolvePtcNodeCommand({ PI_ENV_NODE_BIN: "/selected/node" }, "/nix/store/ld-linux-x86-64.so.2")).toBe("/selected/node");
  });
});
