import { join } from "node:path";
import { Effect } from "effect";
import { configureAtuinHookEffect } from "./atuin-hook.mjs";
import { findExecutableEffect, managedFileEffect } from "./file-ops.mjs";
import { changed, displayPath, ok, section } from "./report.mjs";

const ManagedFiles = Object.freeze([
  {
    path: "APPEND_SYSTEM.md",
    blocks: [
      { name: "append-system", source: "setup/templates/APPEND_SYSTEM.md" },
      { name: "correspondence", source: "setup/templates/correspondence.md" },
    ],
  },
  {
    path: "AGENTS.md",
    blocks: [
      { name: "agent-guidelines", source: "setup/templates/AGENTS.md" },
      {
        name: "atuin-guidelines",
        source: "setup/templates/atuin.md",
        requiresCommand: "atuin",
      },
    ],
  },
]);

export function configurePiEffect(ctx) {
  return Effect.gen(function* () {
    section("Pi");
    yield* registerSettingsEffect(ctx);
    for (const { path, blocks } of ManagedFiles) {
      const resolved = [];
      for (const { name, source, requiresCommand } of blocks) {
        const enabled =
          !requiresCommand || Boolean(yield* findExecutableEffect(ctx, requiresCommand));
        resolved.push({ name, source: join(ctx.sourceRoot, source), enabled });
      }
      const target = join(ctx.agentDir, path);
      yield* managedFileEffect(target, resolved, displayPath(target, ctx.home));
    }
    yield* configureAtuinHookEffect(ctx);
  });
}

function registerSettingsEffect(ctx) {
  return Effect.gen(function* () {
    const settingsFile = join(ctx.agentDir, "settings.json");
    const commandResult = yield* ctx.command(
      ctx.setupNodeBin,
      [
        "setup/apply-managed-settings.mjs",
        settingsFile,
        ctx.repo,
        ...(ctx.env.PI_ENV_RESET_SETTINGS === "1" ? ["--reset"] : []),
      ],
      { cwd: ctx.sourceRoot },
    );
    if (commandResult.stderr.trim()) console.error(commandResult.stderr.trim());
    const result = commandResult.stdout.trim();
    switch (result) {
      case "unchanged":
        ok("settings and package registration");
        break;
      case "created":
        changed("settings.json created with baseline and package registration");
        break;
      case "updated":
        changed("settings package registration updated");
        break;
      default:
        if (result) console.log(result);
    }
  });
}
