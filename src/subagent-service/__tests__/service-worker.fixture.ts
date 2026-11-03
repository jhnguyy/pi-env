import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { fileURLToPath } from "node:url";
import { openServiceRuntime } from "../runtime.js";
import { serve } from "../transport.js";

const [directory, agentDir] = process.argv.slice(2);
const bundleId = createHash("sha256")
  .update(await readFile(fileURLToPath(import.meta.url)))
  .update(process.version)
  .digest("hex");
let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>>;
const runtime = await openServiceRuntime({
  directory,
  agentDir,
  bundleId,
  openStorage: async (file) => {
    storage = await openNodeSqliteStorage(file);
    return storage;
  },
});
async function failStorage(): Promise<void> {
  await storage.close(context);
  try {
    await runtime.submit("fixture-parent", {
      requestId: "storage-probe",
      runId: "probe",
      name: "probe",
      task: "fresh work",
      cwd: process.env.SUBAGENT_FIXTURE_ROOT!,
    });
  } finally {
    await writeFile(join(process.env.SUBAGENT_FIXTURE_ROOT!, "storage-failed"), "closed");
  }
}
let pauseAccepted = false;
runtime.subscribe("fixture-parent", (snapshot) => {
  if (pauseAccepted && snapshot.operations.some((op) => op.status === "accepted")) {
    process.send?.({ paused: snapshot });
    process.kill(process.pid, "SIGSTOP");
  }
});
const transport = await serve(directory, runtime);
let shutdown: Promise<void> | undefined;
const stop = () =>
  (shutdown ??= (async () => {
    const outcomes = await Promise.allSettled([transport.close(), runtime.close()]);
    for (const outcome of outcomes)
      if (outcome.status === "rejected") {
        console.error(outcome.reason);
        process.exitCode = 1;
      }
    process.disconnect?.();
  })());
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
process.on("message", (message) => {
  if (message === "shutdown") void stop();
  if (message === "fail-storage")
    void failStorage().catch((error: unknown) => process.send?.({ storageFailure: String(error) }));
  if (message === "pause-accepted") {
    pauseAccepted = true;
    process.send?.({ armed: true });
  }
});
process.send?.({ ready: true });
