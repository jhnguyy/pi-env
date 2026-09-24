import { streamProcess, type StreamProcessOptions } from "../../../src/process/platform.js";

/** Keep the fixed 1Password read in Pi's terminal session without changing other process callers. */
export function readOnePassword(
  command: string,
  args: readonly string[],
  options: StreamProcessOptions,
) {
  return streamProcess(command, args, { ...options, detached: false });
}
