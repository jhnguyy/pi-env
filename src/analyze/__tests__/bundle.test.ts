import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { bundleAnalyzerEffect, discoverExtensionEntrypointsEffect } from "../external/bundle.js";
import { ScopeMode } from "../model.js";
import { processServiceLayer } from "../process.js";
import type { Scope } from "../scope.js";

const allScope: Scope = { mode: ScopeMode.All, files: [], hunks: new Map() };
const write = (cwd: string, path: string, text: string | undefined) =>
  Effect.tryPromise(async () => {
    if (text === undefined) await rm(join(cwd, path), { force: true });
    else await writeFile(join(cwd, path), text);
  });
const fixture = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "bundle-config-test-"))),
  (cwd) => Effect.tryPromise(() => rm(cwd, { recursive: true, force: true })).pipe(Effect.orDie),
).pipe(
  Effect.tap((cwd) =>
    Effect.tryPromise(async () => {
      await mkdir(join(cwd, ".pi/extensions/alpha"), { recursive: true });
      await writeFile(join(cwd, ".pi/extensions/alpha/index.ts"), "export {};");
    }),
  ),
);

function analyze(cwd: string, requests: unknown[]) {
  return bundleAnalyzerEffect(cwd, allScope, 256).pipe(
    Effect.provide(
      processServiceLayer((_command, _args, options) => {
        requests.push(JSON.parse(String(options?.stdin)));
        return Effect.succeed({
          stdout: JSON.stringify({ version: 1, ok: true, metafile: { inputs: {}, outputs: {} } }),
          stderr: "",
        });
      }),
    ),
  );
}

it.effect.each([
  undefined,
  "{",
  "null",
  "42",
  '"config"',
  "[]",
  JSON.stringify({ workspaces: 42, pi: { extensions: null } }),
  JSON.stringify({ workspaces: "invalid", pi: { extensions: "invalid" } }),
  JSON.stringify({ workspaces: { packages: [".pi/extensions/alpha"] }, pi: "invalid" }),
])("keeps filesystem discovery with absent or invalid registrations: %s", (manifest) =>
  Effect.gen(function* () {
    const cwd = yield* fixture;
    yield* write(cwd, "package.json", manifest);
    expect(yield* discoverExtensionEntrypointsEffect(cwd)).toEqual([
      ".pi/extensions/alpha/index.ts",
    ]);
  }),
);

it.effect.each(["workspaces", "pi"] as const)(
  "retains valid %s registrations despite a malformed sibling",
  (valid) =>
    Effect.gen(function* () {
      const cwd = yield* fixture;
      yield* Effect.tryPromise(async () => {
        await mkdir(join(cwd, "linked"));
        await writeFile(join(cwd, "linked/index.ts"), "export {};");
        // Dirent.isDirectory excludes this link, so registration is the only discovery route.
        await symlink(join(cwd, "linked"), join(cwd, ".pi/extensions/registered"), "dir");
        await symlink(join(cwd, "linked"), join(cwd, ".pi/extensions/rejected"), "dir");
      });
      const paths = [
        ".pi/extensions/registered",
        ".pi/extensions/registered",
        ".pi/extensions/missing",
        "elsewhere",
        ".pi/extensions/deep/nested",
      ];
      const manifest =
        valid === "workspaces"
          ? {
              workspaces: paths,
              pi: { extensions: [".pi/extensions/rejected", 42] },
              ignored: true,
            }
          : {
              workspaces: [".pi/extensions/rejected", 42],
              pi: { extensions: paths, ignored: true },
              ignored: true,
            };
      yield* write(cwd, "package.json", JSON.stringify(manifest));
      expect(yield* discoverExtensionEntrypointsEffect(cwd)).toEqual([
        ".pi/extensions/alpha/index.ts",
        ".pi/extensions/registered/index.ts",
      ]);
    }),
);

it.effect(
  "validates externals before sending them to the worker, including explicit empty configuration",
  () =>
    Effect.gen(function* () {
      const cwd = yield* fixture;
      for (const [text, externals, configured] of [
        [JSON.stringify({ externals: ["pkg", 42] }), [], false],
        [JSON.stringify({ externals: "pkg" }), [], false],
        ["null", [], false],
        ["[]", [], false],
        ["true", [], false],
        ["{", [], false],
        [undefined, [], false],
        [JSON.stringify({ externals: [] }), [], true],
        [JSON.stringify({ externals: ["pkg"], ignored: 42 }), ["pkg"], true],
      ] as const) {
        yield* write(cwd, "pi-build.config.json", text);
        const requests: unknown[] = [];
        const findings = yield* analyze(cwd, requests);
        expect(requests).toEqual([expect.objectContaining({ externals })]);
        expect(findings[0]?.data).toMatchObject({ externalsConfigured: configured });
      }
    }),
);

it.effect("uses the first valid sideEffects declaration, not merely the first present field", () =>
  Effect.gen(function* () {
    const cwd = yield* fixture;
    for (const [local, root, expected] of [
      [
        { sideEffects: "false" },
        { sideEffects: false },
        { packageSideEffects: false, treeShakeable: true, sideEffectsSource: "root" },
      ],
      [
        { sideEffects: ["*.css", 42] },
        { sideEffects: ["root.css"] },
        { packageSideEffects: ["root.css"], treeShakeable: false, sideEffectsSource: "root" },
      ],
      [
        { sideEffects: false },
        { sideEffects: true },
        { packageSideEffects: false, treeShakeable: true, sideEffectsSource: "package" },
      ],
      [
        { sideEffects: true },
        { sideEffects: false },
        { packageSideEffects: true, treeShakeable: false, sideEffectsSource: "package" },
      ],
      [
        { sideEffects: [] },
        { sideEffects: false },
        { packageSideEffects: [], treeShakeable: false, sideEffectsSource: "package" },
      ],
      [
        { sideEffects: ["*.css"], ignored: true },
        { sideEffects: false },
        { packageSideEffects: ["*.css"], treeShakeable: false, sideEffectsSource: "package" },
      ],
      [{ sideEffects: null }, { sideEffects: 42 }, { sideEffectsSource: "missing" }],
      [null, [], { sideEffectsSource: "missing" }],
    ] as const) {
      yield* write(cwd, ".pi/extensions/alpha/package.json", JSON.stringify(local));
      yield* write(cwd, "package.json", JSON.stringify(root));
      const findings = yield* analyze(cwd, []);
      expect(findings[0]?.data).toMatchObject(expected);
      if (expected.sideEffectsSource === "missing") {
        expect(findings[0]?.data).not.toHaveProperty("packageSideEffects");
        expect(findings[0]?.data).not.toHaveProperty("treeShakeable");
      }
    }
    for (const text of [undefined, "{"]) {
      yield* write(cwd, ".pi/extensions/alpha/package.json", text);
      yield* write(cwd, "package.json", text);
      expect((yield* analyze(cwd, []))[0]?.data).toMatchObject({ sideEffectsSource: "missing" });
    }
  }),
);
