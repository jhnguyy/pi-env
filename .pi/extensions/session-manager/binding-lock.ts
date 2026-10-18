import { spawn } from "node:child_process";
import { Data, Effect } from "effect";

class BindingLockFailure extends Data.TaggedError("BindingLockFailure")<{
  message: string;
}> {}

// Kernel ownership, not a PID file or a lease: a paused owner cannot lose its
// lock, and process death closes stdin and releases it. Never unlink the file:
// waiters must continue to lock the same inode. The tmux socket scopes authority.
export const acquireBindingLock = (socketPath: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<() => Promise<void>>((resolve, reject) => {
        const child = spawn(
          "flock",
          [
            "--exclusive",
            "--timeout",
            "5",
            `${socketPath}.pi-bindings.lock`,
            process.execPath,
            "-e",
            'process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); process.stdout.write("ready");',
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        let ready = false;
        let error = "";
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          error += chunk;
        });
        const closed = new Promise<void>((done) => {
          child.once("close", (code) => {
            if (!ready)
              reject(
                new BindingLockFailure({
                  message: error || `flock exited before acquisition (${code})`,
                }),
              );
            done();
          });
        });
        child.once("error", reject);
        child.stdin.on("error", () => {
          /* Exit is handled by close. */
        });
        child.stdout.once("data", () => {
          ready = true;
          resolve(async () => {
            child.stdin.end();
            await closed;
          });
        });
      }),
    catch: (cause) =>
      cause instanceof BindingLockFailure
        ? cause
        : new BindingLockFailure({ message: String(cause) }),
  });
