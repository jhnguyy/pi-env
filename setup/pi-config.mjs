import { join } from "node:path";
import { Effect } from "effect";
import {
  managedFileEffect,
  removeEmptyDirectoryEffect,
  removeOwnedLinkEffect,
} from "./file-ops.mjs";
import { changed, displayPath, ok, section } from "./report.mjs";

const ManagedFiles = Object.freeze([
  {
    path: "APPEND_SYSTEM.md",
    blocks: [
      { name: "append-system", source: ".pi/agent/APPEND_SYSTEM.md" },
      { name: "correspondence", source: "setup/templates/correspondence.md" },
    ],
  },
  {
    path: "AGENTS.md",
    blocks: [{ name: "agent-guidelines", source: "setup/templates/AGENTS.md" }],
  },
]);

// Earlier setup versions created these paths. Entries without a source are directories.
function obsoletePaths(ctx) {
  const testLinks = join(ctx.agentDir, "extensions/__tests__");
  return [
    { target: join(ctx.agentsDir, "roles"), source: ".agents/roles" },
    { target: join(testLinks, "loader.test.ts"), source: ".pi/extensions/__tests__/loader.test.ts" },
    { target: join(testLinks, "test-utils.ts"), source: ".pi/extensions/__tests__/test-utils.ts" },
    { target: testLinks },
  ];
}

function checkoutPaths(ctx, relativePath) {
  return [join(ctx.repo, relativePath), join(ctx.sourceRoot, relativePath)];
}

export function configurePiEffect(ctx) {
  return Effect.gen(function* () {
    section("Pi");
    yield* registerSettingsEffect(ctx);
    for (const { path, blocks } of ManagedFiles) {
      const target = join(ctx.agentDir, path);
      yield* managedFileEffect(
        target,
        blocks.map(({ name, source }) => ({ name, source: join(ctx.sourceRoot, source) })),
        displayPath(target, ctx.home),
      );
    }
    for (const { target, source } of obsoletePaths(ctx)) {
      const label = displayPath(target, ctx.home);
      yield* source
        ? removeOwnedLinkEffect(checkoutPaths(ctx, source), target, label)
        : removeEmptyDirectoryEffect(target, label);
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
