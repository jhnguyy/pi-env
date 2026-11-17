import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect, it as vitestIt } from "vitest";
import {
  decodeAgentSettingsSnapshotEffect,
  readOptionalAgentSettings,
  type AgentSettingsEnv,
} from "../_shared/agent-settings";
import { loadSettingsSnapshotEffect } from "../_shared/settings";

function envWith(files: Record<string, string>, onRead?: (path: string) => void): AgentSettingsEnv {
  return {
    globalSettingsPath: () => "/global/settings.json",
    projectSettingsPath: () => "/repo/.pi/settings.json",
    readFile: (path) => {
      onRead?.(path);
      if (path in files) return files[path];
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
}

describe("agent settings", () => {
  vitestIt("loads agent settings with project precedence", () => {
    const settings = readOptionalAgentSettings(
      envWith({
        "/global/settings.json": JSON.stringify({
          modelAnnotations: { "provider/model": ["preferred"] },
          extensions: ["global-extension"],
        }),
        "/repo/.pi/settings.json": JSON.stringify({ extensions: ["web-context"] }),
      }),
      "/repo",
    );

    expect(settings).toEqual({
      modelAnnotations: { "provider/model": ["preferred"] },
      extensions: ["web-context"],
    });
  });

  vitestIt("distinguishes both-missing from existing-empty for optional settings", () => {
    expect(readOptionalAgentSettings(envWith({}), "/repo")).toBeNull();
    expect(readOptionalAgentSettings(envWith({ "/global/settings.json": "{}" }), "/repo")).toEqual(
      {},
    );
  });

  vitestIt("keeps malformed settings optional at extension call sites", () => {
    expect(
      readOptionalAgentSettings(envWith({ "/global/settings.json": "not json" }), "/repo"),
    ).toBeNull();
  });

  it.effect("attributes invalid agent fields to the overlaid settings paths", () =>
    Effect.gen(function* () {
      const invalidSnapshot = yield* loadSettingsSnapshotEffect(
        "/repo",
        envWith({
          "/global/settings.json": JSON.stringify({ modelAnnotations: { "test/model": [123] } }),
        }),
      );
      const invalid = yield* Effect.result(decodeAgentSettingsSnapshotEffect(invalidSnapshot));
      expect(invalid._tag).toBe("Failure");
      if (invalid._tag === "Failure")
        expect(invalid.failure).toMatchObject({
          _tag: "SettingsDecodeError",
          source: "overlay",
          paths: { global: "/global/settings.json", project: "/repo/.pi/settings.json" },
        });
    }),
  );

  vitestIt("loads optional settings with one snapshot and no duplicate reads", () => {
    const reads: string[] = [];
    const settings = readOptionalAgentSettings(
      envWith({ "/global/settings.json": "{}" }, (path) => reads.push(path)),
      "/repo",
    );

    expect(settings).toEqual({});
    expect(reads).toEqual(["/global/settings.json", "/repo/.pi/settings.json"]);
  });
});
