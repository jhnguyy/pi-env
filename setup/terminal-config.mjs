import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
      skip("~/.config/ghostty (managed externally)");
      return;
    }
    if (ctx.env.SHOULD_LINK_GHOSTTY !== "1") {
      skip(
        `~/.config/ghostty (not needed for ${ctx.env.CONTEXT_LABEL ?? "this context"}; set PI_ENV_LINK_GHOSTTY=1 to force)`,
      );
      return;
    }
    const canCreate = yield* Effect.sync(() => {
      try {
        mkdirSync(join(ctx.ghosttyConfigDir, "themes"), { recursive: true });
        return true;
      } catch {
        return false;
      }
    });
    if (!canCreate) {
      skip(`~/.config/ghostty (cannot create ${ctx.ghosttyConfigDir})`);
      return;
    }
    yield* linkPathEffect(
      join(ctx.repo, "ghostty/config"),
      join(ctx.ghosttyConfigDir, "config"),
      "~/.config/ghostty/config",
    );
    yield* linkPathEffect(
      join(ctx.repo, "ghostty/themes/pi-env-gruvbox-dark"),
      join(ctx.ghosttyConfigDir, "themes/pi-env-gruvbox-dark"),
      "~/.config/ghostty/themes/pi-env-gruvbox-dark",
    );
    yield* linkPathEffect(
      join(ctx.repo, "ghostty/themes/pi-env-gruvbox-light"),
      join(ctx.ghosttyConfigDir, "themes/pi-env-gruvbox-light"),
      "~/.config/ghostty/themes/pi-env-gruvbox-light",
    );
  });
}
