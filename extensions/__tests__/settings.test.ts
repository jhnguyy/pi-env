import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import {
  SettingsDecodeError,
  SettingsReadError,
  SettingsSource,
  decodeSettingsBlockEffect,
  loadSettingsSnapshotEffect,
  readSettingsBlockEffect,
  type SettingsEnv,
} from "../_shared/settings";

function envWith(files: Record<string, string>, onRead?: (path: string) => void): SettingsEnv {
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

describe("settings boundary", () => {
  it.effect("treats missing files as empty absent layers", () =>
    Effect.gen(function* () {
      const snapshot = yield* loadSettingsSnapshotEffect("/repo", envWith({}));
      const block = yield* readSettingsBlockEffect("tool", "/repo", envWith({}));

      expect(snapshot.exists).toEqual({ global: false, project: false });
      expect(snapshot.merged).toEqual({});
      expect(block).toEqual({});
    }),
  );

  it.effect("reads global-only and project-only blocks", () =>
    Effect.gen(function* () {
      expect(yield* readSettingsBlockEffect("tool", "/repo", envWith({ "/global/settings.json": JSON.stringify({ tool: { a: 1 } }) }))).toEqual({ a: 1 });
      expect(yield* readSettingsBlockEffect("tool", "/repo", envWith({ "/repo/.pi/settings.json": JSON.stringify({ tool: { b: 2 } }) }))).toEqual({ b: 2 });
    }),
  );

  it.effect("applies global then project shallow block overlay with nested replacement", () =>
    Effect.gen(function* () {
      const block = yield* readSettingsBlockEffect("tool", "/repo", envWith({
        "/global/settings.json": JSON.stringify({ tool: { keep: true, nested: { a: 1 } } }),
        "/repo/.pi/settings.json": JSON.stringify({ tool: { nested: { b: 2 } } }),
      }));

      expect(block).toEqual({ keep: true, nested: { b: 2 } });
    }),
  );

  it.effect("reports malformed global JSON and project JSON with exact source/path", () =>
    Effect.gen(function* () {
      const global = yield* Effect.result(loadSettingsSnapshotEffect("/repo", envWith({ "/global/settings.json": "{" })));
      const project = yield* Effect.result(loadSettingsSnapshotEffect("/repo", envWith({
        "/global/settings.json": "{}",
        "/repo/.pi/settings.json": "{",
      })));

      expect(global._tag).toBe("Failure");
      if (global._tag === "Failure") expect(global.failure).toMatchObject({ _tag: "SettingsDecodeError", source: SettingsSource.Global, path: "/global/settings.json" });
      expect(project._tag).toBe("Failure");
      if (project._tag === "Failure") expect(project.failure).toMatchObject({ _tag: "SettingsDecodeError", source: SettingsSource.Project, path: "/repo/.pi/settings.json" });
    }),
  );

  it.effect("reports non-object roots as exact-source decode errors", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(loadSettingsSnapshotEffect("/repo", envWith({ "/global/settings.json": "[]" })));

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(SettingsDecodeError);
      if (result._tag === "Failure") expect(result.failure).toMatchObject({ source: SettingsSource.Global, path: "/global/settings.json" });
    }),
  );

  it.effect("reports non-ENOENT read failures as SettingsReadError with source/path", () => {
    const env = envWith({});
    env.readFile = (path) => {
      if (path === "/global/settings.json") throw Object.assign(new Error("denied"), { code: "EACCES" });
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    return Effect.gen(function* () {
      const result = yield* Effect.result(loadSettingsSnapshotEffect("/repo", env));

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(SettingsReadError);
      if (result._tag === "Failure") expect(result.failure).toMatchObject({ source: SettingsSource.Global, path: "/global/settings.json" });
    });
  });

  it.effect("rejects present non-object blocks with their exact source", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(decodeSettingsBlockEffect("tool", Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) }), "/repo", envWith({
        "/global/settings.json": JSON.stringify({ tool: { enabled: true } }),
        "/repo/.pi/settings.json": JSON.stringify({ tool: "invalid" }),
      })));

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toMatchObject({
        _tag: "SettingsDecodeError",
        source: SettingsSource.Project,
        path: "/repo/.pi/settings.json",
        key: "tool",
      });
    }),
  );

  it.effect("reports schema-invalid merged blocks with key and overlay paths", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(decodeSettingsBlockEffect("tool", Schema.Struct({ enabled: Schema.Boolean }), "/repo", envWith({
        "/global/settings.json": JSON.stringify({ tool: { enabled: true } }),
        "/repo/.pi/settings.json": JSON.stringify({ tool: { enabled: "yes" } }),
      })));

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toMatchObject({
        _tag: "SettingsDecodeError",
        source: SettingsSource.Overlay,
        key: "tool",
        path: "/global/settings.json + /repo/.pi/settings.json",
        paths: { global: "/global/settings.json", project: "/repo/.pi/settings.json" },
      });
    }),
  );
});
