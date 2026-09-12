import { open, realpath } from "node:fs/promises";
import { Data, Effect } from "effect";

const MAX_HEADER_BYTES = 64 * 1024;

export class SessionFileInvalid extends Data.TaggedError("SessionFileInvalid")<{
  path: string;
  reason: string;
}> {}
export class SessionFileReadFailure extends Data.TaggedError("SessionFileReadFailure")<{
  path: string;
  cause: unknown;
}> {}
export type SessionFileError = SessionFileInvalid | SessionFileReadFailure;

export interface SessionFileProbe {
  readonly exists: (path: string) => Effect.Effect<boolean, SessionFileReadFailure>;
  readonly verify: (
    path: string,
    expectedSessionId: string,
    expectedCwd: string,
  ) => Effect.Effect<void, SessionFileError>;
}

const errno = (cause: unknown, code: string) =>
  typeof cause === "object" && cause !== null && (cause as NodeJS.ErrnoException).code === code;

export const nodeSessionFileProbe: SessionFileProbe = {
  exists: (path) =>
    Effect.tryPromise({
      try: async () => {
        const file = await open(path, "r");
        await file.close();
        return true;
      },
      catch: (cause) => new SessionFileReadFailure({ path, cause }),
    }).pipe(Effect.catchIf((error) => errno(error.cause, "ENOENT"), () => Effect.succeed(false))),
  verify: (path, expectedSessionId, expectedCwd) =>
    Effect.tryPromise({
      try: async () => {
        const file = await open(path, "r");
        try {
          const buffer = Buffer.alloc(MAX_HEADER_BYTES + 1);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
          if (newline < 0) {
            throw new SessionFileInvalid({ path, reason: "missing bounded header line" });
          }
          const line = buffer.subarray(0, newline).toString("utf8");
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            throw new SessionFileInvalid({ path, reason: "invalid JSON header" });
          }
          if (
            typeof value !== "object" ||
            value === null ||
            (value as { type?: unknown }).type !== "session" ||
            (value as { id?: unknown }).id !== expectedSessionId ||
            typeof (value as { cwd?: unknown }).cwd !== "string"
          ) {
            throw new SessionFileInvalid({ path, reason: "session header identity mismatch" });
          }
          const headerCwd = await realpath((value as { cwd: string }).cwd);
          if (headerCwd !== expectedCwd) {
            throw new SessionFileInvalid({ path, reason: "session header workspace mismatch" });
          }
        } finally {
          await file.close();
        }
      },
      catch: (cause) =>
        cause instanceof SessionFileInvalid ? cause : new SessionFileReadFailure({ path, cause }),
    }),
};
