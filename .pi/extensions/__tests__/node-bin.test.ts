import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { findNodeBinaryEffect, type BinaryLookupEnv } from "../_shared/node-bin";

class FakeProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
}

function runLookup(name: string, fromPath: string, env: BinaryLookupEnv): Promise<string | null> {
  return Effect.runPromise(findNodeBinaryEffect(name, pathToFileURL(fromPath).href, env));
}

describe("findNodeBinaryEffect", () => {
  it("walks upward to find workspace node_modules binaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-env-node-bin-"));
    try {
      const binDir = join(root, "node_modules", ".bin");
      const nestedDir = join(root, "packages", "tool", "src");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(nestedDir, { recursive: true });
      const binPath = join(binDir, "example-language-server");
      const fromPath = join(nestedDir, "index.js");
      writeFileSync(binPath, "#!/bin/sh\n");
      writeFileSync(fromPath, "");

      const result = await runLookup("example-language-server", fromPath, {
        exists: (path) => path === binPath,
        spawn: () => { throw new Error("PATH fallback should not run"); },
      });

      expect(result).toBe(binPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to PATH lookup when no local binary exists", async () => {
    const proc = new FakeProcess();
    const resultPromise = runLookup("example", import.meta.url, {
      exists: () => false,
      spawn: () => {
        queueMicrotask(() => {
          proc.stdout.emit("data", Buffer.from("/usr/bin/example\n"));
          proc.emit("close", 0);
        });
        return proc;
      },
    });

    await expect(resultPromise).resolves.toBe("/usr/bin/example");
  });

  it("returns null when the PATH shell cannot be spawned", async () => {
    const result = await runLookup("missing", import.meta.url, {
      exists: () => false,
      spawn: () => { throw Object.assign(new Error("spawn sh ENOENT"), { code: "ENOENT" }); },
    });

    expect(result).toBeNull();
  });
});
