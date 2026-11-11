import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { fileEffect, findExecutableEffect } from "./file-ops.mjs";
import { changed, displayPath, kept, note } from "./report.mjs";

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
          const result = yield* ctx.command(executable, ["hook", "install", "pi"], {
            check: false,
            env: { PI_CODING_AGENT_DIR: stage },
          });
          if (result.status !== 0) {
            note(`${label} skipped: native hook installation unavailable`);
            return;
          }
          yield* fileEffect("install Atuin hook", target, () => {
            const body = readFileSync(join(stage, "extensions/atuin.ts"));
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
