import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
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
  it("treats missing files as empty absent layers", async () => {
    const snapshot = await Effect.runPromise(loadSettingsSnapshotEffect("/repo", envWith({})));
    const block = await Effect.runPromise(readSettingsBlockEffect("tool", "/repo", envWith({})));

    expect(snapshot.exists).toEqual({ global: false, project: false });
    expect(snapshot.merged).toEqual({});
    expect(block).toEqual({});
  });

  it("reads global-only and project-only blocks", async () => {
    await expect(Effect.runPromise(readSettingsBlockEffect("tool", "/repo", envWith({ "/global/settings.json": JSON.stringify({ tool: { a: 1 } }) })))).resolves.toEqual({ a: 1 });
    await expect(Effect.runPromise(readSettingsBlockEffect("tool", "/repo", envWith({ "/repo/.pi/settings.json": JSON.stringify({ tool: { b: 2 } }) })))).resolves.toEqual({ b: 2 });
  });

  it("applies global then project shallow block overlay with nested replacement", async () => {
    const block = await Effect.runPromise(readSettingsBlockEffect("tool", "/repo", envWith({
      "/global/settings.json": JSON.stringify({ tool: { keep: true, nested: { a: 1 } } }),
      "/repo/.pi/settings.json": JSON.stringify({ tool: { nested: { b: 2 } } }),
    })));

    expect(block).toEqual({ keep: true, nested: { b: 2 } });
  });

  it("reports malformed global JSON and project JSON with exact source/path", async () => {
    const global = await Effect.runPromise(Effect.either(loadSettingsSnapshotEffect("/repo", envWith({ "/global/settings.json": "{" }))));
    const project = await Effect.runPromise(Effect.either(loadSettingsSnapshotEffect("/repo", envWith({
      "/global/settings.json": "{}",
      "/repo/.pi/settings.json": "{",
    }))));

    expect(global._tag).toBe("Left");
    if (global._tag === "Left") expect(global.left).toMatchObject({ _tag: "SettingsDecodeError", source: SettingsSource.Global, path: "/global/settings.json" });
    expect(project._tag).toBe("Left");
    if (project._tag === "Left") expect(project.left).toMatchObject({ _tag: "SettingsDecodeError", source: SettingsSource.Project, path: "/repo/.pi/settings.json" });
  });

  it("reports non-object roots as exact-source decode errors", async () => {
    const result = await Effect.runPromise(Effect.either(loadSettingsSnapshotEffect("/repo", envWith({ "/global/settings.json": "[]" }))));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(SettingsDecodeError);
    if (result._tag === "Left") expect(result.left).toMatchObject({ source: SettingsSource.Global, path: "/global/settings.json" });
  });

  it("reports non-ENOENT read failures as SettingsReadError with source/path", async () => {
    const env = envWith({});
    env.readFile = (path) => {
      if (path === "/global/settings.json") throw Object.assign(new Error("denied"), { code: "EACCES" });
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    const result = await Effect.runPromise(Effect.either(loadSettingsSnapshotEffect("/repo", env)));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(SettingsReadError);
    if (result._tag === "Left") expect(result.left).toMatchObject({ source: SettingsSource.Global, path: "/global/settings.json" });
  });

  it("rejects present non-object blocks with their exact source", async () => {
    const result = await Effect.runPromise(Effect.either(decodeSettingsBlockEffect("tool", Schema.Struct({ enabled: Schema.optional(Schema.Boolean) }), "/repo", envWith({
      "/global/settings.json": JSON.stringify({ tool: { enabled: true } }),
      "/repo/.pi/settings.json": JSON.stringify({ tool: "invalid" }),
    }))));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toMatchObject({
      _tag: "SettingsDecodeError",
      source: SettingsSource.Project,
      path: "/repo/.pi/settings.json",
      key: "tool",
    });
  });

  it("reports schema-invalid merged blocks with key and overlay paths", async () => {
    const result = await Effect.runPromise(Effect.either(decodeSettingsBlockEffect("tool", Schema.Struct({ enabled: Schema.Boolean }), "/repo", envWith({
      "/global/settings.json": JSON.stringify({ tool: { enabled: true } }),
      "/repo/.pi/settings.json": JSON.stringify({ tool: { enabled: "yes" } }),
    }))));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toMatchObject({
      _tag: "SettingsDecodeError",
      source: SettingsSource.Overlay,
      key: "tool",
      path: "/global/settings.json + /repo/.pi/settings.json",
      paths: { global: "/global/settings.json", project: "/repo/.pi/settings.json" },
    });
  });
});
