import { join } from "node:path";
import { Effect } from "effect";
import { managedFileEffect } from "./file-ops.mjs";
import { changed, displayPath, ok, section } from "./report.mjs";

const managedFiles = (atuinGuidance) => [
  {
    path: "APPEND_SYSTEM.md",
    blocks: [
      { name: "append-system", sources: ["setup/templates/APPEND_SYSTEM.md"] },
      { name: "correspondence", sources: ["setup/templates/correspondence.md"] },
    ],
  },
  {
    path: "AGENTS.md",
    blocks: [
      {
        name: "agent-guidelines",
        sources: [
          "setup/templates/AGENTS.md",
          ...(atuinGuidance ? ["setup/templates/atuin.md"] : []),
        ],
      },
    ],
  },
];

export function configurePiEffect(ctx) {
  return Effect.gen(function* () {
    section("Pi");
    yield* registerSettingsEffect(ctx);
    for (const { path, blocks } of managedFiles(ctx.env.PI_ENV_ATUIN_GUIDANCE === "1")) {
      const target = join(ctx.agentDir, path);
      yield* managedFileEffect(
        target,
        blocks.map(({ name, sources }) => ({
          name,
          sources: sources.map((source) => join(ctx.sourceRoot, source)),
        })),
        displayPath(target, ctx.home),
      );
    }
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
