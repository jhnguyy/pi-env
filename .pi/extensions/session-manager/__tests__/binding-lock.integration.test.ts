import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { acquireBindingLock } from "../binding-lock.js";

// Real Pi E2E cannot reliably kill a process during the short critical section.
// This real child holds exactly that resource, then dies without finalization.
it("releases the kernel lock when its owning process is killed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-binding-lock-"));
  const socket = join(root, "tmux.sock");
  const module = new URL("../binding-lock.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { Effect } from "effect";
    import { acquireBindingLock } from ${JSON.stringify(module)};
    await Effect.runPromise(acquireBindingLock(${JSON.stringify(socket)}));
    process.stdout.write("locked");
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const [ready] = await once(child.stdout, "data");
    expect(ready.toString()).toBe("locked");
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
    const release = await Effect.runPromise(acquireBindingLock(socket));
    await release();
  } finally {
    child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
