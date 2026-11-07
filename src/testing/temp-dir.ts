import { mkdtempDisposableSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

// Call from a test or beforeEach. Vitest runs onTestFinished callbacks in reverse order, so
// create the directory before registering cleanup for processes or sessions that use it.
export async function forTest(prefix = "pi-env-test-"): Promise<string> {
  const dir = await mkdtempDisposable(join(tmpdir(), prefix));
  onTestFinished(() => dir[Symbol.asyncDispose]());
  return dir.path;
}

export function forTestSync(prefix = "pi-env-test-"): string {
  const dir = mkdtempDisposableSync(join(tmpdir(), prefix));
  onTestFinished(() => dir[Symbol.dispose]());
  return dir.path;
}
