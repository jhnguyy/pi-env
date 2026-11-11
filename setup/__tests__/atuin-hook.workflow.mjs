import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { configureAtuinHookEffect } from "../atuin-hook.mjs";

using root = mkdtempDisposableSync(join(tmpdir(), "pi-env-atuin-safety-"));
const body = "export default function fixtureHook() {}\n";

function fixture(name, { status = 0, beforeInstall } = {}) {
  const dir = join(root.path, name);
  const bin = join(dir, "bin");
  const agentDir = join(dir, "custom-agent");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "atuin"), "", { mode: 0o700 });
  const target = join(agentDir, "extensions/atuin.ts");
  const stages = [];
  const ctx = {
    repo: dir,
    agentDir,
    home: dir,
    env: { PATH: bin },
    command(_executable, _args, { env }) {
      return Effect.sync(() => {
        const stage = env.PI_CODING_AGENT_DIR;
        stages.push(stage);
        mkdirSync(join(stage, "extensions"), { recursive: true });
        writeFileSync(join(stage, "extensions/atuin.ts"), body);
        beforeInstall?.(target);
        return { status };
      });
    },
  };
  return { target, stages, run: () => Effect.runPromise(configureAtuinHookEffect(ctx)) };
}

const installed = fixture("install");
await installed.run();
await installed.run();
assert.equal(readFileSync(installed.target, "utf8"), body);
assert.ok(installed.stages.every((path) => !existsSync(path)));

for (const kind of ["custom-file", "dangling-symlink"]) {
  const f = fixture(kind);
  mkdirSync(dirname(f.target), { recursive: true });
  if (kind === "custom-file") writeFileSync(f.target, "operator-owned");
  else symlinkSync("missing-nix-generation", f.target);
  await f.run();
  if (kind === "custom-file") assert.equal(readFileSync(f.target, "utf8"), "operator-owned");
  else assert.equal(readlinkSync(f.target), "missing-nix-generation");
}

const raced = fixture("race", {
  beforeInstall: (target) => {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "concurrent-owner");
  },
});
await raced.run();
assert.equal(readFileSync(raced.target, "utf8"), "concurrent-owner");
assert.ok(raced.stages.every((path) => !existsSync(path)));

const failed = fixture("failed-installer", { status: 1 });
await failed.run();
assert.ok(!existsSync(failed.target), "failed generation must not install partial output");
assert.ok(failed.stages.every((path) => !existsSync(path)));
console.log("Atuin hook ownership and cleanup checks passed");
