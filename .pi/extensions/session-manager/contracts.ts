import { Data } from "effect";

export const ManifestVersion = 1 as const;
export type PendingPersistence = { readonly state: "pending" };
export type MaterializedPersistence = {
  readonly state: "materialized";
  readonly sessionFile: string;
};
export type Persistence = PendingPersistence | MaterializedPersistence;
export type TaskRef = { readonly provider: "notes"; readonly reference: string };
type Base = {
  readonly version: 1;
  readonly sessionId: string;
  readonly cwd: string;
  readonly name: string;
  readonly persistence: Persistence;
  readonly createdAt: string;
  readonly lastOpenedAt: string;
};
type WorkBase = Base & { readonly taskRef?: TaskRef };
export type CoordinatorRecord = Base & { readonly role: "coordinator" };
export type OpenSessionRecord = WorkBase & {
  readonly role: "work";
  readonly desiredState: "open";
};
export type ClosedSessionRecord = WorkBase & {
  readonly role: "work";
  readonly desiredState: "closed";
  readonly closedAt: string;
  readonly closedBy: "ctrl-d" | "session-done";
};
export type SessionRecord = CoordinatorRecord | OpenSessionRecord | ClosedSessionRecord;
export type SessionManifest = {
  readonly version: 1;
  readonly canonicalCwd: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly coordinator?: CoordinatorRecord;
  readonly sessions: readonly (OpenSessionRecord | ClosedSessionRecord)[];
};

export class ManifestMalformed extends Data.TaggedError("ManifestMalformed")<{
  path: string;
  reason: string;
}> {}
export class ManifestUnsupportedVersion extends Data.TaggedError("ManifestUnsupportedVersion")<{
  path: string;
  version: unknown;
}> {}
export class ManifestSemanticFailure extends Data.TaggedError("ManifestSemanticFailure")<{
  path: string;
  reason: string;
}> {}
export class ManifestReadFailure extends Data.TaggedError("ManifestReadFailure")<{
  path: string;
  cause: unknown;
}> {}
export class ManifestLockTimeout extends Data.TaggedError("ManifestLockTimeout")<{
  path: string;
  cause: unknown;
}> {}
export class ManifestLockCompromised extends Data.TaggedError("ManifestLockCompromised")<{
  path: string;
  cause: unknown;
}> {}
export class ManifestOperationFailure extends Data.TaggedError("ManifestOperationFailure")<{
  path: string;
  cause: unknown;
}> {}
export class ManifestCommitFailure extends Data.TaggedError("ManifestCommitFailure")<{
  path: string;
  cause: unknown;
}> {}
export class ManifestCommitIndeterminate extends Data.TaggedError("ManifestCommitIndeterminate")<{
  path: string;
  revision: number;
  cause: unknown;
}> {}
export class ManifestCommittedReleaseFailed extends Data.TaggedError(
  "ManifestCommittedReleaseFailed",
)<{ path: string; revision: number; cause: unknown }> {}
export type SessionCatalogFailure =
  | ManifestMalformed
  | ManifestUnsupportedVersion
  | ManifestSemanticFailure
  | ManifestReadFailure
  | ManifestLockTimeout
  | ManifestLockCompromised
  | ManifestOperationFailure
  | ManifestCommitFailure
  | ManifestCommitIndeterminate
  | ManifestCommittedReleaseFailed;
export type ManifestIdentity = { readonly canonicalCwd: string; readonly manifestPath: string };
