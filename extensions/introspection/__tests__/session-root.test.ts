import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as TempDir from "../../../src/testing/temp-dir";

async function fixture() {
  const root = TempDir.forTestSync("introspection-root-");
  const home = join(root, "home");
  const agent = join(root, "custom-agent");
  const sessions = join(agent, "sessions");
  const legacy = join(home, ".pi", "agent", "sessions");
  const nested = join(sessions, "project", "_children", "parent");
  mkdirSync(nested, { recursive: true });
  mkdirSync(legacy, { recursive: true });
  const file = join(nested, "child.jsonl");
  const transcript = (id: string) =>
    [
      { type: "session", id, cwd: "/synthetic-repo", timestamp: "2026-01-01T00:00:00Z" },
      { type: "message", message: { role: "user", content: "synthetic needle" } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
  writeFileSync(file, transcript("configured-child"));
  const legacyFile = join(legacy, "legacy.jsonl");
  writeFileSync(legacyFile, transcript("legacy"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agent);
  // Keep both native homedir conventions isolated before importing the reader.
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  return {
    root,
    sessions,
    file,
    legacyFile,
    navigation: await import("../sessions"),
    read: await import("../read"),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("native session root", () => {
  it("lists and searches nested sessions only under the configured agent root", async () => {
    const { file, navigation } = await fixture();
    expect(navigation.discoverSessionFiles()).toEqual([file]);
    expect(navigation.listSessionDigests().map((digest) => digest.sessionId)).toEqual([
      "configured-child",
    ]);
    const result = await navigation.searchSessionMessages({ term: "needle" });
    expect(result.matches.map((match) => match.file)).toEqual([file]);
  });

  it("reads configured sessions by path and ID with consistent realpath guards", async () => {
    const { file, legacyFile, sessions, read } = await fixture();
    expect((await read.executeReadSession({ path: file })).details.sessionId).toBe(
      "configured-child",
    );
    expect((await read.executeReadSession({ sessionId: "configured-child" })).details.file).toBe(
      resolve(file),
    );
    await expect(read.executeReadSession({ path: legacyFile })).rejects.toThrow("restricted");
    const escape = join(sessions, "escape.jsonl");
    symlinkSync(legacyFile, escape);
    await expect(read.executeReadSession({ path: escape })).rejects.toThrow("restricted");
  });
});
