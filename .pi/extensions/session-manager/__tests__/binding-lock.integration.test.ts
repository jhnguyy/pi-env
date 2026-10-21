import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { startBindingLockOwner } from "./binding-lock-fixture.js";

// Real Pi E2E cannot reliably kill a process during the short critical section.
// This real child holds exactly that resource, then dies without finalization.
it("releases the kernel lock when its owning process is killed", async ({ task }) => {
  // Share the configured integration budget across acquisitions and reserve time for cleanup.
  const readinessDeadline = performance.now() + Math.max(0, task.timeout - 5_000);
  const root = await mkdtemp(join(tmpdir(), "pi-binding-lock-"));
  const owners: ReturnType<typeof startBindingLockOwner>[] = [];
  onTestFinished(async () => {
    const results = await Promise.allSettled(owners.map((owner) => owner.stop()));
    const failures: unknown[] = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "Binding lock fixture cleanup failed");
  });
  const socket = join(root, "tmux.sock");
  const owner = startBindingLockOwner(socket, readinessDeadline);
  owners.push(owner);
  await expect(owner.ready, "initial owner readiness").resolves.toBeUndefined();
  expect(owner.child.kill("SIGKILL")).toBe(true);
  expect(await owner.closed).toEqual({ code: null, signal: "SIGKILL" });

  const replacement = startBindingLockOwner(socket, readinessDeadline);
  owners.push(replacement);
  await expect(replacement.ready, "post-SIGKILL reacquisition").resolves.toBeUndefined();
});
