#!/usr/bin/env node
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { connect } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function identity(path) {
  try {
    const file = await stat(path);
    return `${file.dev}:${file.ino}`;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function restartDaemon(socketPath, pidPath, timeoutMs = 5_000) {
  const originals = await Promise.all([identity(socketPath), identity(pidPath)]);
  const stopped = await new Promise((done, reject) => {
    const socket = connect(socketPath);
    let acknowledged = false;
    let missing = false;
    let failure;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("Daemon shutdown timed out")));
    socket.once("connect", () => socket.write('{"id":1,"action":"shutdown"}\n'));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 64 * 1024)
        return socket.destroy(new Error("Invalid daemon shutdown response"));
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.id !== 1 || !response.ok || response.result?.running !== false)
          throw new Error("Daemon refused shutdown");
        acknowledged = true;
      } catch (error) {
        socket.destroy(error);
      }
    });
    socket.once("error", (error) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") missing = true;
      else failure = error;
    });
    socket.once("close", () => {
      if (failure) reject(failure);
      else if (missing) done(false);
      else if (acknowledged) done(true);
      else reject(new Error("Daemon closed before acknowledging shutdown"));
    });
  });
  if (!stopped) return;

  // EOF acknowledges the protocol, not cleanup. Wait behind the daemon's
  // lifetime lock, but never signal a PID or remove another process's artifacts.
  await new Promise((done, reject) =>
    execFile(
      "flock",
      [
        "--exclusive",
        "--timeout",
        String(timeoutMs / 1_000),
        `${socketPath}.lock`,
        process.execPath,
        "-e",
        "",
      ],
      { timeout: timeoutMs + 1_000 },
      (error) => (error ? reject(error) : done()),
    ),
  );
  // Older daemons do not hold the lock; also wait for their original artifacts.
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const current = await Promise.all([identity(socketPath), identity(pidPath)]);
    if (current.every((value, index) => value === undefined || value !== originals[index])) return;
    if (Date.now() >= deadline) throw new Error("Daemon shutdown did not release its artifacts");
    await new Promise((done) => setTimeout(done, 25));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const uid = process.getuid?.() ?? 1000;
  const [socketPath = `/tmp/pi-lsp-${uid}.sock`, pidPath = `/tmp/pi-lsp-${uid}.pid`] =
    process.argv.slice(2);
  restartDaemon(socketPath, pidPath).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
