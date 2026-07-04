import { Data } from "effect";

export const PiUpdatePhase = {
  ResolveRepo: "resolve-repo",
  ResolveVersion: "resolve-version",
  Worktree: "worktree",
  Artifacts: "artifacts",
  PackageDiscovery: "package-discovery",
  Command: "command",
} as const;
export type PiUpdatePhase = typeof PiUpdatePhase[keyof typeof PiUpdatePhase];

export class PiUpdateError extends Data.TaggedError("PiUpdateError")<{
  readonly phase: PiUpdatePhase;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    const reason = this.cause instanceof Error ? `: ${this.cause.message}` : this.cause === undefined ? "" : `: ${String(this.cause)}`;
    return `pi-update ${this.phase} failed: ${this.detail}${reason}`;
  }
}
