import { spawn } from "node:child_process";
import { Data, Effect } from "effect";

class FileLockFailure extends Data.TaggedError("FileLockFailure")<{ message: string }> {}

// Keep the inode: kernel ownership survives pauses, and closing stdin or process
// death releases the helper's flock. Removing the file would split the lock.
export const acquireFileLock = (path: string, waitSeconds = 5) =>
  Effect.tryPromise({
    try: () =>
      new Promise<() => Promise<void>>((resolve, reject) => {
        const child = spawn(
          "flock",
          [
            "--exclusive",
            "--timeout",
            String(waitSeconds),
            path,
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
                new FileLockFailure({
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
      cause instanceof FileLockFailure ? cause : new FileLockFailure({ message: String(cause) }),
  });
