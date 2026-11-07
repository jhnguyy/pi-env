import type {
  ClosedSessionRecord,
  OpenSessionRecord,
  SessionManifest,
  SessionRecord,
} from "./contracts.js";

export const CloseSource = {
  CtrlD: "ctrl-d",
  SessionDone: "session-done",
} as const;
export type CloseSource = (typeof CloseSource)[keyof typeof CloseSource];

export function findRecord(
  manifest: SessionManifest,
  sessionId: string,
): SessionRecord | undefined {
  if (manifest.coordinator?.sessionId === sessionId) return manifest.coordinator;
  return manifest.sessions.find((record) => record.sessionId === sessionId);
}

export function replaceWorkRecord(
  manifest: SessionManifest,
  record: OpenSessionRecord | ClosedSessionRecord,
): SessionManifest {
  const sessions = manifest.sessions
    .filter((candidate) => candidate.sessionId !== record.sessionId)
    .concat(record)
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.sessionId.localeCompare(right.sessionId),
    );
  return { ...manifest, sessions };
}
