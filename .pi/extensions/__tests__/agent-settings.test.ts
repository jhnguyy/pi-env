import { it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { describe, expect, it as vitestIt } from "vitest";
import {
  AgentSettingsSchema,
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
  it.effect("parses shared settings from overlaid settings.json files", () =>
    Effect.gen(function* () {
      const snapshot = yield* loadSettingsSnapshotEffect("/repo", envWith({
        "/global/settings.json": JSON.stringify({
          enabledModels: ["global/model"],
          modelAnnotations: { "provider/model": ["preferred"] },
          workTracker: { repos: ["/repo"], protectedBranches: ["main"] },
        }),
        "/repo/.pi/settings.json": JSON.stringify({ enabledModels: ["project/model"], extensions: ["web-context"] }),
      }));
      const settings = yield* decodeAgentSettingsSnapshotEffect(snapshot);

      expect(settings).toEqual({
        modelAnnotations: { "provider/model": ["preferred"] },
        workTracker: { repos: ["/repo"], protectedBranches: ["main"] },
        extensions: ["web-context"],
      });
    }),
  );

  it.effect("leaves native model selection settings to Pi", () =>
    Effect.gen(function* () {
      const settings = yield* Schema.decodeUnknownEffect(AgentSettingsSchema)({
        enabledModels: ["test/selected"],
        modelAnnotations: { "test/available": ["reviewer"] },
      });
      expect(settings).toEqual({ modelAnnotations: { "test/available": ["reviewer"] } });
    }),
  );

  it.effect("accepts an absent root key and rejects a present undefined root key", () =>
    Effect.gen(function* () {
      expect(yield* Schema.decodeUnknownEffect(AgentSettingsSchema)({})).toEqual({});
      const presentUndefined = yield* Effect.result(
        Schema.decodeUnknownEffect(AgentSettingsSchema)({ modelAnnotations: undefined }),
      );
      expect(Result.isFailure(presentUndefined)).toBe(true);
    }),
  );

  it.effect("accepts an absent nested key and rejects a present undefined nested key", () =>
    Effect.gen(function* () {
      expect(yield* Schema.decodeUnknownEffect(AgentSettingsSchema)({ workTracker: {} })).toEqual({ workTracker: {} });
      const presentUndefined = yield* Effect.result(
        Schema.decodeUnknownEffect(AgentSettingsSchema)({ workTracker: { repos: undefined } }),
      );
      expect(Result.isFailure(presentUndefined)).toBe(true);
    }),
  );

  vitestIt("distinguishes both-missing from existing-empty for optional settings", () => {
    expect(readOptionalAgentSettings(envWith({}), "/repo")).toBeNull();
    expect(readOptionalAgentSettings(envWith({ "/global/settings.json": "{}" }), "/repo")).toEqual({});
  });

  vitestIt("keeps malformed settings optional at extension call sites", () => {
    expect(readOptionalAgentSettings(envWith({ "/global/settings.json": "not json" }), "/repo")).toBeNull();
  });

  it.effect("reports typed errors for required settings", () =>
    Effect.gen(function* () {
      const malformed = yield* Effect.result(loadSettingsSnapshotEffect("/repo", envWith({ "/global/settings.json": "not json" })));
      const invalidSnapshot = yield* loadSettingsSnapshotEffect("/repo", envWith({ "/global/settings.json": JSON.stringify({ modelAnnotations: { "test/model": [123] } }) }));
      const invalid = yield* Effect.result(decodeAgentSettingsSnapshotEffect(invalidSnapshot));

      expect(malformed._tag).toBe("Failure");
      if (malformed._tag === "Failure") expect(malformed.failure).toMatchObject({ _tag: "SettingsDecodeError", path: "/global/settings.json", source: "global" });
      expect(invalid._tag).toBe("Failure");
      if (invalid._tag === "Failure") expect(invalid.failure).toMatchObject({ _tag: "SettingsDecodeError", source: "overlay", paths: { global: "/global/settings.json", project: "/repo/.pi/settings.json" } });
    }),
  );

  vitestIt("loads optional settings with one snapshot and no duplicate reads", () => {
    const reads: string[] = [];
    const settings = readOptionalAgentSettings(envWith({ "/global/settings.json": "{}" }, (path) => reads.push(path)), "/repo");

    expect(settings).toEqual({});
    expect(reads).toEqual(["/global/settings.json", "/repo/.pi/settings.json"]);
  });
});
