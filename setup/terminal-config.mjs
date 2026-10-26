import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { fileEffect, linkPathEffect } from "./file-ops.mjs";
import { changed, displayPath, note, ok, section } from "./report.mjs";

const GhosttyThemes = Object.freeze(["pi-env-gruvbox-dark", "pi-env-gruvbox-light"]);

export function configureTerminalToolsEffect(ctx, policy) {
  return Effect.gen(function* () {
    section("Terminal tools");
    if (!policy.terminal.enabled) {
      note("terminal tools (disabled by setup option)");
      return;
    }
    yield* configureTmuxEffect(ctx, policy);
    yield* configureGhosttyEffect(ctx, policy);
  });
}

function configureTmuxEffect(ctx, policy) {
  const tmuxConf = join(ctx.home, ".tmux.conf");
  const sourceLine = `source-file ${join(ctx.sourceRoot, "setup/templates/tmux.conf")}`;
  return fileEffect("configure tmux", tmuxConf, () => {
    if (!policy.terminal.tmux.configure) {
      note("tmux config (managed externally)");
      return;
    }
    if (existsSync(tmuxConf) && readFileSync(tmuxConf, "utf8").includes(sourceLine)) {
      ok("tmux-gruvbox.conf sourced from ~/.tmux.conf");
    } else if (existsSync(tmuxConf)) {
      appendFileSync(tmuxConf, `\n${sourceLine}\n`);
      changed("tmux-gruvbox.conf appended to ~/.tmux.conf");
    } else {
      writeFileSync(tmuxConf, `${sourceLine}\n`);
      changed("tmux-gruvbox.conf → new ~/.tmux.conf");
    }
  });
}

function configureGhosttyEffect(ctx, policy) {
  const { ghostty } = policy.terminal;
  const configDir = ctx.ghosttyConfigDir;
  const configLabel = displayPath(configDir, ctx.home);
  const themesDir = join(ctx.xdgConfigHome, "ghostty/themes");
  return Effect.gen(function* () {
    if (!ghostty.configure) {
      note(`${configLabel} (managed externally)`);
      return;
    }
    if (!ghostty.needed) {
      note(
        `${configLabel} (not needed for ${ghostty.context}; set PI_ENV_LINK_GHOSTTY=1 to force)`,
      );
      return;
    }
    const canCreate = yield* Effect.sync(() => {
      try {
        mkdirSync(configDir, { recursive: true });
        mkdirSync(themesDir, { recursive: true });
        return true;
      } catch {
        return false;
      }
    });
    if (!canCreate) {
      note(`${configLabel} (cannot create)`);
      return;
    }
    const links = [
      { source: join(ctx.sourceRoot, "ghostty/config"), target: join(configDir, "config") },
      ...GhosttyThemes.map((theme) => ({
        source: join(ctx.sourceRoot, "ghostty/themes", theme),
        target: join(themesDir, theme),
      })),
    ];
    for (const { source, target } of links) {
      yield* linkPathEffect(source, target, displayPath(target, ctx.home));
    }
  });
}
