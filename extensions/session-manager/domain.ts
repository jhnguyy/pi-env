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
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
      return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0;
    });
  return { ...manifest, sessions };
}
