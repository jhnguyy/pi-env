import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

type Exec = ExtensionAPI["exec"];

export type ExecErrorFactory<E> = (detail: string, cause?: unknown) => E;

export interface ExecEffectOptions {
  readonly cwd?: string;
  readonly timeout?: number;
  readonly failOnNonZero?: boolean;
  readonly failureDetail?: string;
}

export function execEffect<E>(
  exec: Exec,
  command: string,
  args: string[],
  makeError: ExecErrorFactory<E>,
  options: ExecEffectOptions = {},
): Effect.Effect<ExecResult, E> {
  const rendered = [command, ...args].join(" ");
  return Effect.tryPromise({
    try: (signal) =>
      exec(command, args, {
        cwd: options.cwd,
        timeout: options.timeout ?? 120000,
        signal,
      }),
    catch: (cause) => makeError(options.failureDetail ?? `${rendered} failed.`, cause),
  }).pipe(
    Effect.flatMap((result) => {
      if (options.failOnNonZero === false || result.code === 0) return Effect.succeed(result);
      return Effect.fail(
        makeError(`${rendered} exited ${result.code}: ${result.stderr || result.stdout}`),
      );
    }),
  );
}
