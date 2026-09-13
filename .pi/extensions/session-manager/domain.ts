import { randomInt } from "node:crypto";
import type {
  ClosedSessionRecord,
  OpenSessionRecord,
  SessionManifest,
  SessionRecord,
} from "./contracts.js";

const adjectives = [
  "amber",
  "blue",
  "bright",
  "calm",
  "clear",
  "green",
  "quiet",
  "silver",
  "swift",
  "warm",
] as const;
const nouns = [
  "cedar",
  "fox",
  "heron",
  "lake",
  "maple",
  "otter",
  "pine",
  "river",
  "sparrow",
  "willow",
] as const;

export const CloseSource = {
  CtrlD: "ctrl-d",
  SessionDone: "session-done",
} as const;
export type CloseSource = (typeof CloseSource)[keyof typeof CloseSource];

export type NameEntropy = (upperBound: number) => number;
export const secureNameEntropy: NameEntropy = randomInt;

export function nameCandidates(
  entropy: NameEntropy,
  count = adjectives.length * nouns.length,
): readonly string[] {
  const start = entropy(adjectives.length * nouns.length);
  return Array.from({ length: count }, (_, offset) => {
    const index = (start + offset) % (adjectives.length * nouns.length);
    const adjective = adjectives[Math.floor(index / nouns.length)];
    const noun = nouns[index % nouns.length];
    return `${adjective}-${noun}`;
  });
}

export function selectAvailableName(
  manifest: SessionManifest,
  candidates: readonly string[],
  prefix = "",
): string | undefined {
  const activeNames = new Set<string>();
  if (manifest.coordinator) activeNames.add(manifest.coordinator.name);
  for (const record of manifest.sessions) {
    if (record.desiredState === "open") activeNames.add(record.name);
  }
  return candidates.map((candidate) => `${prefix}${candidate}`).find((name) => !activeNames.has(name));
}

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
        left.createdAt.localeCompare(right.createdAt) || left.sessionId.localeCompare(right.sessionId),
    );
  return { ...manifest, sessions };
}
