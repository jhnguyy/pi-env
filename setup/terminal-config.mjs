import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { ok, section, skip } from "./runtime-support.mjs";
import { fileEffect, linkPathEffect, linked } from "./file-ops.mjs";

export function configureTerminalToolsEffect(ctx, policy) {
  return Effect.gen(function* () {
    section("Terminal tools");
    if (!policy.terminal.enabled) {
      skip("terminal tools (disabled by setup option)");
      return;
    }
    yield* configureTmuxEffect(ctx, policy);
    yield* configureGhosttyEffect(ctx, policy);
  });
}

function configureTmuxEffect(ctx, policy) {
  return fileEffect("configure tmux", ctx.tmuxConf, () => {
    if (!policy.terminal.tmux.configure) {
      skip("tmux config (managed externally)");
      return;
    }
    if (
      existsSync(ctx.tmuxConf) &&
      readFileSync(ctx.tmuxConf, "utf8").includes(ctx.tmuxSourceLine)
    ) {
      ok("tmux-gruvbox.conf sourced from ~/.tmux.conf");
    } else if (existsSync(ctx.tmuxConf)) {
      appendFileSync(ctx.tmuxConf, `\n${ctx.tmuxSourceLine}\n`);
      linked("tmux-gruvbox.conf appended to ~/.tmux.conf");
    } else {
      writeFileSync(ctx.tmuxConf, `${ctx.tmuxSourceLine}\n`);
      linked("tmux-gruvbox.conf → new ~/.tmux.conf");
    }
  });
}

function configureGhosttyEffect(ctx, policy) {
  return Effect.gen(function* () {
    if (!policy.terminal.ghostty.configure) {
      skip(`${ctx.ghosttyConfigDir} (managed externally)`);
      return;
    }
    if (ctx.env.SHOULD_LINK_GHOSTTY !== "1") {
      skip(
        `${ctx.ghosttyConfigDir} (not needed for ${ctx.env.CONTEXT_LABEL ?? "this context"}; set PI_ENV_LINK_GHOSTTY=1 to force)`,
      );
      return;
    }
    const themesDir = join(ctx.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ghostty", "themes");
    const canCreate = yield* Effect.sync(() => {
      try {
        mkdirSync(ctx.ghosttyConfigDir, { recursive: true });
        mkdirSync(themesDir, { recursive: true });
        return true;
      } catch {
        return false;
      }
    });
    if (!canCreate) {
      skip(`${ctx.ghosttyConfigDir} (cannot create)`);
      return;
    }
    yield* linkPathEffect(
      join(ctx.repo, "ghostty/config"),
      join(ctx.ghosttyConfigDir, "config"),
      join(ctx.ghosttyConfigDir, "config"),
    );
    yield* linkPathEffect(
      join(ctx.repo, "ghostty/themes/pi-env-gruvbox-dark"),
      join(themesDir, "pi-env-gruvbox-dark"),
      join(themesDir, "pi-env-gruvbox-dark"),
    );
    yield* linkPathEffect(
      join(ctx.repo, "ghostty/themes/pi-env-gruvbox-light"),
      join(themesDir, "pi-env-gruvbox-light"),
      join(themesDir, "pi-env-gruvbox-light"),
    );
  });
}
