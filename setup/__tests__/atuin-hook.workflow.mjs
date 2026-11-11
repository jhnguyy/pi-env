import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { join } from "node:path";
import { Effect } from "effect";
import { configureAtuinHookEffect } from "../atuin-hook.mjs";
import { SetupStateError } from "../setup-errors.mjs";

using root = mkdtempDisposableSync(join(tmpdir(), "pi-env-atuin-safety-"));
const body = "export default function approvedFixture() {}\n";

function fixture(name, { generated = body, beforeWrite, fail = false } = {}) {
  const dir = join(root.path, name);
  const sourceRoot = join(dir, "source");
  const bin = join(dir, "bin");
  const agentDir = join(dir, "custom-agent");
  mkdirSync(join(sourceRoot, "setup"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(bin, "atuin"), "", { mode: 0o700 });
  writeFileSync(
    join(sourceRoot, "setup/atuin-pi-hook.sha256"),
    createHash("sha256").update(body).digest("hex"),
  );
  const target = join(agentDir, "extensions/atuin.ts");
  const stages = [];
  const ctx = {
    repo: dir,
    sourceRoot,
    agentDir,
    home: dir,
    env: { PATH: bin },
    command(executable, args, options) {
      return Effect.gen(function* () {
        assert.equal(executable, join(bin, "atuin"));
        assert.deepEqual(args, ["hook", "install", "pi"]);
        assert.equal(options.timeout, 10_000);
        const env = options.env;
        assert.notEqual(env.HOME, dir);
        assert.notEqual(env.PI_CODING_AGENT_DIR, agentDir);
        assert.equal(env.PI_AGENT_DIR, env.PI_CODING_AGENT_DIR);
        assert.ok(env.ATUIN_HOME.startsWith(env.HOME));
        assert.match(
          readFileSync(join(env.ATUIN_CONFIG_DIR, "config.toml"), "utf8"),
          /auto_sync = false/,
        );
        stages.push(env.HOME);
        if (fail) return yield* Effect.fail(new SetupStateError("fixture installer failure"));
        mkdirSync(join(env.PI_CODING_AGENT_DIR, "extensions"), { recursive: true });
        writeFileSync(join(env.PI_CODING_AGENT_DIR, "extensions/atuin.ts"), generated);
        beforeWrite?.(target);
        return { stdout: "", stderr: "", status: 0 };
      });
    },
  };
  return { ctx, target, stages, run: () => Effect.runPromise(configureAtuinHookEffect(ctx)) };
}

const installed = fixture("install");
await installed.run();
assert.equal(readFileSync(installed.target, "utf8"), body);
assert.equal(installed.stages.length, 1);
assert.ok(installed.stages.every((path) => !existsSync(path)));
await installed.run();
assert.equal(
  installed.stages.length,
  1,
  "rerun must not invoke an installer over an existing hook",
);

for (const kind of ["custom-file", "dangling-symlink"]) {
  const f = fixture(kind);
  mkdirSync(join(f.ctx.agentDir, "extensions"), { recursive: true });
  if (kind === "custom-file") writeFileSync(f.target, "operator-owned");
  else symlinkSync("missing-nix-generation", f.target);
  await f.run();
  assert.equal(f.stages.length, 0);
  if (kind === "custom-file") assert.equal(readFileSync(f.target, "utf8"), "operator-owned");
  else assert.equal(readlinkSync(f.target), "missing-nix-generation");
}

const raced = fixture("race", {
  beforeWrite: (target) => {
    mkdirSync(join(raced.ctx.agentDir, "extensions"), { recursive: true });
    writeFileSync(target, "concurrent-owner");
  },
});
await raced.run();
assert.equal(readFileSync(raced.target, "utf8"), "concurrent-owner");
assert.ok(raced.stages.every((path) => !existsSync(path)));

for (const [name, options, message] of [
  ["unreviewed", { generated: "unreviewed source" }, /unreviewed Pi hook/],
  ["failure", { fail: true }, /fixture installer failure/],
]) {
  const f = fixture(name, options);
  await assert.rejects(f.run(), message);
  assert.ok(!existsSync(f.target));
  assert.ok(f.stages.every((path) => !existsSync(path)));
}

const missing = fixture("missing");
missing.ctx.env.PATH = "";
await missing.run();
assert.equal(missing.stages.length, 0);
assert.ok(!existsSync(missing.target));
console.log("Atuin hook installation safety passed");
