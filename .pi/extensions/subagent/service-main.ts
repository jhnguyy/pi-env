import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openServiceRuntime } from "../../../src/subagent-service/runtime.js";
import { serve } from "../../../src/subagent-service/transport.js";

const [directory, agentDir] = process.argv.slice(2);
if (!directory) throw new Error("Usage: subagent:service <private-state-directory> [agent-directory]");
const bundleId = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).update(process.version).digest("hex");
const runtime = await openServiceRuntime({ directory, agentDir, bundleId });
let transport: Awaited<ReturnType<typeof serve>>;
try { transport = await serve(directory, runtime); }
catch (error) { await runtime.close(); throw error; }
let shutdown: Promise<void> | undefined;
const stop = () => shutdown ??= (async () => {
  const outcomes = await Promise.allSettled([transport.close(), runtime.close()]);
  if (outcomes.some((outcome) => outcome.status === "rejected")) process.exitCode = 1;
  process.disconnect?.();
})();
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
process.on("message", (message) => { if (message === "shutdown") void stop(); });
process.send?.({ ready: true });
process.stdout.write("Shared native subagent service ready.\n");
