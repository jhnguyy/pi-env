/**
 * @module _shared/settings
 * @purpose Shared Effect seam for pi settings.json files.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Data, Effect, Schema } from "effect";

export type SettingsBlock = Record<string, unknown>;

export const SettingsSource = {
  Global: "global",
  Project: "project",
  Overlay: "overlay",
} as const;
export type SettingsSource = typeof SettingsSource[keyof typeof SettingsSource];

export interface SettingsEnv {
  globalSettingsPath(): string;
  projectSettingsPath(cwd: string): string;
  readFile(path: string, encoding: BufferEncoding): string;
}

export interface SettingsSnapshot {
  readonly paths: { readonly global: string; readonly project: string };
  readonly global: SettingsBlock;
  readonly project: SettingsBlock;
  readonly exists: { readonly global: boolean; readonly project: boolean };
  readonly merged: SettingsBlock;
}

export class SettingsReadError extends Data.TaggedError("SettingsReadError")<{
  readonly source: SettingsSource;
  readonly path: string;
  readonly cause: unknown;
}> {}

export class SettingsDecodeError extends Data.TaggedError("SettingsDecodeError")<{
  readonly source: SettingsSource;
  readonly path: string;
  readonly cause: unknown;
  readonly key?: string;
  readonly paths?: { readonly global: string; readonly project: string };
}> {}

export type SettingsError = SettingsReadError | SettingsDecodeError;

const SettingsObjectSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });

export const defaultSettingsEnv: SettingsEnv = {
  globalSettingsPath: () => join(getAgentDir(), "settings.json"),
  projectSettingsPath: (cwd) => join(cwd, ".pi", "settings.json"),
  readFile: readFileSync,
};

export function settingsPaths(cwd = process.cwd(), env: SettingsEnv = defaultSettingsEnv): { global: string; project: string } {
  return { global: env.globalSettingsPath(), project: env.projectSettingsPath(cwd) };
}

export function loadSettingsSnapshotEffect(cwd = process.cwd(), env: SettingsEnv = defaultSettingsEnv): Effect.Effect<SettingsSnapshot, SettingsError> {
  return Effect.gen(function* () {
    const paths = settingsPaths(cwd, env);
    const globalLayer = yield* readSettingsDocumentEffect(paths.global, SettingsSource.Global, env);
    const projectLayer = yield* readSettingsDocumentEffect(paths.project, SettingsSource.Project, env);
    return {
      paths,
      global: globalLayer.document,
      project: projectLayer.document,
      exists: { global: globalLayer.exists, project: projectLayer.exists },
      merged: { ...globalLayer.document, ...projectLayer.document },
    };
  });
}

export function readSettingsBlockEffect(key: string, cwd = process.cwd(), env: SettingsEnv = defaultSettingsEnv): Effect.Effect<SettingsBlock, SettingsError> {
  return Effect.map(loadSettingsSnapshotEffect(cwd, env), (snapshot) => mergeBlockFromSnapshot(snapshot, key));
}

export function decodeSettingsBlockEffect<S extends Schema.Schema.AnyNoContext>(
  key: string,
  schema: S,
  cwd = process.cwd(),
  env: SettingsEnv = defaultSettingsEnv,
): Effect.Effect<Schema.Schema.Type<S>, SettingsError> {
  return Effect.flatMap(loadSettingsSnapshotEffect(cwd, env), (snapshot) => decodeSettingsBlockFromSnapshotEffect(snapshot, key, schema));
}

export function decodeSettingsBlockFromSnapshotEffect<S extends Schema.Schema.AnyNoContext>(
  snapshot: SettingsSnapshot,
  key: string,
  schema: S,
): Effect.Effect<Schema.Schema.Type<S>, SettingsDecodeError> {
  const invalidSource = invalidBlockSource(snapshot, key);
  if (invalidSource) {
    const path = invalidSource === SettingsSource.Global ? snapshot.paths.global : snapshot.paths.project;
    const document = invalidSource === SettingsSource.Global ? snapshot.global : snapshot.project;
    return Effect.fail(new SettingsDecodeError({
      source: invalidSource,
      path,
      paths: snapshot.paths,
      key,
      cause: document[key],
    }));
  }

  const block = mergeBlockFromSnapshot(snapshot, key);
  return Schema.decodeUnknown(schema)(block).pipe(
    Effect.mapError((cause) => new SettingsDecodeError({
      source: SettingsSource.Overlay,
      path: `${snapshot.paths.global} + ${snapshot.paths.project}`,
      paths: snapshot.paths,
      key,
      cause,
    })),
  );
}

export function readSettingsBlock(key: string, cwd = process.cwd(), env: SettingsEnv = defaultSettingsEnv): SettingsBlock {
  return Effect.runSync(readSettingsBlockEffect(key, cwd, env));
}

export function decodeSettingsBlockSync<S extends Schema.Schema.AnyNoContext>(key: string, schema: S, cwd = process.cwd(), env: SettingsEnv = defaultSettingsEnv): Schema.Schema.Type<S> {
  return Effect.runSync(decodeSettingsBlockEffect(key, schema, cwd, env));
}

function objectAt(root: SettingsBlock, key: string): SettingsBlock {
  const value = root[key];
  return isObject(value) ? value : {};
}

export function parseBooleanSetting(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
  if (/^(0|false|no|off)$/i.test(value.trim())) return false;
  return undefined;
}

export function booleanSetting(value: unknown, envValue: unknown, defaultValue: boolean): boolean {
  return parseBooleanSetting(envValue) ?? parseBooleanSetting(value) ?? defaultValue;
}

export function isObject(value: unknown): value is SettingsBlock {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeBlockFromSnapshot(snapshot: SettingsSnapshot, key: string): SettingsBlock {
  return { ...objectAt(snapshot.global, key), ...objectAt(snapshot.project, key) };
}

function invalidBlockSource(snapshot: SettingsSnapshot, key: string): SettingsSource | undefined {
  if (key in snapshot.global && !isObject(snapshot.global[key])) return SettingsSource.Global;
  if (key in snapshot.project && !isObject(snapshot.project[key])) return SettingsSource.Project;
  return undefined;
}

function readSettingsDocumentEffect(path: string, source: SettingsSource, env: SettingsEnv): Effect.Effect<{ document: SettingsBlock; exists: boolean }, SettingsError> {
  return Effect.flatMap(readOptionalFileEffect(path, source, env), (content): Effect.Effect<{ document: SettingsBlock; exists: boolean }, SettingsDecodeError> => {
    if (content === null) return Effect.succeed({ document: {}, exists: false });
    return Effect.map(decodeJsonObjectEffect(content, path, source), (document) => ({ document, exists: true }));
  });
}

function readOptionalFileEffect(path: string, source: SettingsSource, env: SettingsEnv): Effect.Effect<string | null, SettingsReadError> {
  return Effect.catchAll(
    Effect.try({
      try: () => env.readFile(path, "utf8"),
      catch: (cause) => new SettingsReadError({ source, path, cause }),
    }),
    (error) => isMissingFileError(error.cause) ? Effect.succeed(null) : Effect.fail(error),
  );
}

function decodeJsonObjectEffect(content: string, path: string, source: SettingsSource): Effect.Effect<SettingsBlock, SettingsDecodeError> {
  return Effect.flatMap(
    Effect.try({
      try: () => JSON.parse(content) as unknown,
      catch: (cause) => new SettingsDecodeError({ source, path, cause }),
    }),
    (parsed) => Schema.decodeUnknown(SettingsObjectSchema)(parsed).pipe(
      Effect.mapError((cause) => new SettingsDecodeError({ source, path, cause })),
    ),
  );
}

function isMissingFileError(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}
