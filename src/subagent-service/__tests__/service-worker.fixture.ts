import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openServiceRuntime } from "../runtime.js";
import { serve } from "../transport.js";

const [directory, agentDir] = process.argv.slice(2);
const bundleId = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).update(process.version).digest("hex");
const runtime = await openServiceRuntime({ directory, agentDir, bundleId });
let pauseAccepted = false;
runtime.subscribe("fixture-parent", (snapshot) => {
  if (pauseAccepted && snapshot.operations.some((op) => op.status === "accepted")) {
    process.send?.({ paused: snapshot });
    process.kill(process.pid, "SIGSTOP");
  }
});
const transport = await serve(directory, runtime);
let shutdown: Promise<void> | undefined;
const stop = () => shutdown ??= (async () => {
  const outcomes = await Promise.allSettled([transport.close(), runtime.close()]);
  for (const outcome of outcomes) if (outcome.status === "rejected") { console.error(outcome.reason); process.exitCode = 1; }
  process.disconnect?.();
})();
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
process.on("message", (message) => {
  if (message === "shutdown") void stop();
  if (message === "pause-accepted") { pauseAccepted = true; process.send?.({ armed: true }); }
});
process.send?.({ ready: true });
