#!/usr/bin/env node
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { connect } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { daemonPaths } from "../extensions/dev-tools/paths.ts";
import { resolveNodeCommand } from "../src/process/platform.ts";

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
  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("Daemon restart timed out; cleanup may still be running", "TimeoutError"),
      ),
    timeoutMs,
  );
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const stop = async () => {
    const originals = await Promise.all([identity(socketPath), identity(pidPath)]);
    signal.throwIfAborted();
    const stopped = await new Promise((done, reject) => {
      const socket = connect({ path: socketPath, signal });
      let acknowledged = false;
      let missing = false;
      let failure;
      let buffer = "";
      socket.setEncoding("utf8");
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
    signal.throwIfAborted();

    // EOF acknowledges the protocol, not cleanup. This waiter can be cancelled
    // without signaling the daemon or removing its artifacts.
    await new Promise((done, reject) =>
      execFile(
        "flock",
        ["--exclusive", `${socketPath}.lock`, resolveNodeCommand(), "-e", ""],
        { signal },
        (error) => (error ? reject(error) : done()),
      ),
    );
    // Older daemons do not hold the lock; also wait for their original artifacts.
    while (true) {
      signal.throwIfAborted();
      const current = await Promise.all([identity(socketPath), identity(pidPath)]);
      if (
        current.every(
          (value, index) =>
            value === undefined || (originals[index] !== undefined && value !== originals[index]),
        )
      )
        return;
      await delay(25, undefined, { signal });
    }
  };
  try {
    await Promise.race([stop(), aborted]);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const paths = daemonPaths();
    const [socketPath = paths.socketPath, pidPath = paths.pidPath] = process.argv.slice(2);
    await restartDaemon(socketPath, pidPath);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
