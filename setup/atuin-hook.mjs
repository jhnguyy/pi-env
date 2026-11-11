import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { fileEffect, findExecutableEffect } from "./file-ops.mjs";
import { changed, displayPath, kept } from "./report.mjs";
import { SetupStateError } from "./setup-errors.mjs";

export function configureAtuinHookEffect(ctx) {
  return Effect.gen(function* () {
    const target = join(ctx.agentDir, "extensions/atuin.ts");
    const label = displayPath(target, ctx.home);
    const exists = yield* fileEffect("inspect Atuin hook", target, () => {
      try {
        lstatSync(target);
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    });
    if (exists) {
      kept(`${label} (existing hook; update through its owner)`);
      return;
    }
    const executable = yield* findExecutableEffect(ctx, "atuin");
    if (!executable) return;

    yield* Effect.acquireUseRelease(
      fileEffect("stage Atuin hook", target, () => mkdtempSync(join(tmpdir(), "pi-env-atuin-"))),
      (stage) =>
        Effect.gen(function* () {
          const config = join(stage, "config");
          const agent = join(stage, "agent");
          yield* fileEffect("isolate Atuin configuration", config, () => {
            mkdirSync(config);
            writeFileSync(
              join(config, "config.toml"),
              "auto_sync = false\n[daemon]\nenabled = false\nautostart = false\n[threads]\ncapture = false\n",
            );
          });
          yield* ctx.command(executable, ["hook", "install", "pi"], {
            timeout: 10_000,
            env: {
              HOME: stage,
              PI_AGENT_DIR: agent,
              PI_CODING_AGENT_DIR: agent,
              ATUIN_CONFIG_DIR: config,
              ATUIN_HOME: join(stage, "data"),
            },
          });
          yield* fileEffect("install reviewed Atuin hook", target, () => {
            const body = readFileSync(join(agent, "extensions/atuin.ts"));
            const expected = readFileSync(
              join(ctx.sourceRoot, "setup/atuin-pi-hook.sha256"),
              "utf8",
            ).trim();
            if (createHash("sha256").update(body).digest("hex") !== expected) {
              throw new SetupStateError(
                "Atuin emitted an unreviewed Pi hook; existing hooks were not changed.",
              );
            }
            mkdirSync(dirname(target), { recursive: true });
            try {
              writeFileSync(target, body, { flag: "wx", mode: 0o600 });
              changed(`${label} (upstream Atuin command hook installed; reload Pi)`);
            } catch (error) {
              if (error.code !== "EEXIST") throw error;
              kept(`${label} (created by another owner during setup)`);
            }
          });
        }),
      (stage) => Effect.sync(() => rmSync(stage, { recursive: true, force: true })),
    );
  });
}
