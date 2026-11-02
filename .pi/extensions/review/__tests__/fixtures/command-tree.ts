import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [pidPath, childPidPath] = process.argv.slice(2);
if (!pidPath) throw new Error("A fixture PID path is required");

// Self-owned failure insurance cannot signal an unrelated process after PID reuse.
// The test rejects a watchdog marker, so this exit cannot satisfy cancellation coverage.
setTimeout(() => {
  writeFileSync(`${pidPath}.watchdog`, "fixture watchdog fired\n");
  process.exit(88);
}, 8_000).unref();

if (childPidPath) {
  process.on("SIGTERM", () => {});
  spawn(process.execPath, [import.meta.filename, childPidPath], { stdio: "ignore" });
}
writeFileSync(pidPath, String(process.pid));
setInterval(() => {}, 1_000);
