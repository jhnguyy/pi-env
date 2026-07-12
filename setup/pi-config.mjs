import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { ok, section } from "./runtime-support.mjs";
import {
  appendOnceEffect,
  bootstrapFileEffect,
  fileEffect,
  linkPathEffect,
  linked,
} from "./file-ops.mjs";

export function configurePiEffect(ctx) {
  return Effect.gen(function* () {
    section("Pi");
    yield* bootstrapFileEffect(
      join(ctx.setupDir, "templates/settings.json"),
      ctx.settingsFile,
      "settings.json (exists — not overwritten)",
      "settings.json ← setup/templates/settings.json (review and customize: defaultModel, permissionLevel)",
    );
    yield* applyManagedSettingsEffect(ctx);
    yield* fileEffect("create directory", ctx.agentsDir, () =>
      mkdirSync(ctx.agentsDir, { recursive: true }),
    );
    yield* fileEffect("create directory", ctx.testUtilsDir, () =>
      mkdirSync(ctx.testUtilsDir, { recursive: true }),
    );
    yield* linkPathEffect(
      join(ctx.repo, ".agents/roles"),
      join(ctx.agentsDir, "roles"),
      "~/.agents/roles",
    );
    yield* linkPathEffect(
      join(ctx.repo, ".pi/extensions/__tests__/test-utils.ts"),
      join(ctx.testUtilsDir, "test-utils.ts"),
      "~/.pi/agent/extensions/__tests__/test-utils.ts",
    );
    yield* linkPathEffect(
      join(ctx.repo, ".pi/extensions/__tests__/loader.test.ts"),
      join(ctx.testUtilsDir, "loader.test.ts"),
      "~/.pi/agent/extensions/__tests__/loader.test.ts",
    );
    yield* appendOnceEffect(
      ctx.appendSrc,
      ctx.appendDst,
      ctx.appendMarker,
      "~/.pi/agent/APPEND_SYSTEM.md",
    );
    yield* bootstrapFileEffect(
      join(ctx.repo, "AGENTS.md"),
      join(ctx.piAgentDir, "AGENTS.md"),
      "~/.pi/agent/AGENTS.md (exists — not overwritten)",
      "~/.pi/agent/AGENTS.md (bootstrapped from repo — customize for your environment)",
    );
  });
}

function applyManagedSettingsEffect(ctx) {
  return Effect.try({
    try: () => {
      const result = ctx
        .run(
          ctx.setupNodeBin,
          ["setup/apply-managed-settings.mjs", ctx.settingsFile, ctx.managedSettingsFile, ctx.repo],
          { cwd: ctx.repo },
        )
        .stdout.trim();
      switch (result) {
        case "unchanged":
          ok("managed settings and package registration");
          break;
        case "created":
          linked("settings.json created with managed settings and package registration");
          break;
        case "updated":
          linked("managed settings applied to settings.json");
          break;
        default:
          if (result) console.log(result);
      }
    },
    catch: (error) => error,
  });
}
