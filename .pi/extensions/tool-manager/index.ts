import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Effect } from "effect";
import { decodeSettingsBlockEffect } from "../_shared/settings";
import {
  CUSTOM_TYPE,
  SEARCH_TOOL_NAME,
  ToolManagerSettingsSchema,
  expandEntries,
  expandRequestedEntries,
  latestStateFromEntries,
  profileTools,
  resolveConfig,
  searchTools,
  setAdditive,
  triggerGroups,
  unknownEntries,
  type ResolvedConfig,
} from "./core";

function loadConfig(cwd = process.cwd()): ResolvedConfig {
  try {
    return resolveConfig(Effect.runSync(decodeSettingsBlockEffect("toolManager", ToolManagerSettingsSchema, cwd)));
  } catch {
    return resolveConfig({});
  }
}

function all(pi: ExtensionAPI): ToolInfo[] {
  return pi.getAllTools().sort((a, b) => a.name.localeCompare(b.name));
}

function persist(pi: ExtensionAPI, active: string[], reason: "profile" | "toggle" | "auto" | "search" | "reset", profile?: string): void {
  pi.appendEntry(CUSTOM_TYPE, { active, reason, profile, at: new Date().toISOString() });
}

function apply(pi: ExtensionAPI, names: string[], config: ResolvedConfig): string[] {
  const available = new Set(pi.getAllTools().map((tool) => tool.name));
  const next = [...new Set([...names, SEARCH_TOOL_NAME, ...config.alwaysActive])].filter((name) => available.has(name));
  pi.setActiveTools(next);
  return next;
}

function branchEntries(ctx: ExtensionContext): unknown[] {
  return ctx.sessionManager.getBranch();
}

function status(pi: ExtensionAPI, config: ResolvedConfig): string {
  const active = pi.getActiveTools().sort();
  return [`Active tools (${active.length}): ${active.join(", ")}`, `Default profile: ${config.defaultProfile}`].join("\n");
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(message, type);
}

function notifyChanges(
  ctx: ExtensionCommandContext,
  verb: "Enabled" | "Disabled",
  changed: readonly string[],
  unknown: readonly string[],
): void {
  notify(
    ctx,
    [`${verb}: ${changed.join(", ") || "-"}`, unknown.length ? `Unknown: ${unknown.join(", ")}` : ""]
      .filter(Boolean)
      .join("\n"),
    unknown.length ? "warning" : "info",
  );
}

function enableTools(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: ResolvedConfig,
  names: readonly string[],
): void {
  const tools = all(pi);
  const unknown = unknownEntries(names, config, tools);
  const before = new Set(pi.getActiveTools());
  const next = setAdditive(pi.getActiveTools(), expandEntries(names, config, tools), config, tools);
  apply(pi, next, config);
  persist(pi, next, "toggle");
  notifyChanges(ctx, "Enabled", next.filter((name) => !before.has(name)), unknown);
}

function disableTools(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: ResolvedConfig,
  names: readonly string[],
): void {
  const tools = all(pi);
  const unknown = unknownEntries(names, config, tools);
  const remove = new Set(
    expandRequestedEntries(names, config, tools).filter((name) => !config.alwaysActive.includes(name)),
  );
  const before = pi.getActiveTools();
  const next = setAdditive(
    before.filter((name) => !remove.has(name)),
    [],
    config,
    tools,
  );
  apply(pi, next, config);
  persist(pi, next, "toggle");
  notifyChanges(ctx, "Disabled", before.filter((name) => !next.includes(name)), unknown);
}

function applyProfile(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: ResolvedConfig,
  profile: string,
  reason: "profile" | "reset",
): void {
  if (!(profile in config.profiles)) {
    notify(ctx, reason === "reset" ? `Unknown default profile: ${profile}` : `Unknown profile: ${profile}`, "error");
    return;
  }
  const next = profileTools(profile, config, all(pi));
  apply(pi, next, config);
  persist(pi, next, reason, profile);
  notify(ctx, `${reason === "reset" ? "Reset to" : "Applied profile"} ${profile}: ${next.join(", ") || "-"}`);
}

export async function handleToolsCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  config: ResolvedConfig,
): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const command = parts[0];
  const names = parts.slice(1);

  if (!command) {
    if (ctx.mode === "tui") await openToolsTui(pi, ctx, config);
    else notify(ctx, status(pi, config));
    return;
  }

  switch (command) {
    case "status":
      notify(ctx, status(pi, config));
      return;
    case "on":
      enableTools(pi, ctx, config, names);
      return;
    case "off":
      disableTools(pi, ctx, config, names);
      return;
    case "profile":
      if (names[0]) applyProfile(pi, ctx, config, names[0], "profile");
      else notify(ctx, "Usage: /tools profile <name>", "warning");
      return;
    case "reset":
      applyProfile(pi, ctx, config, config.defaultProfile, "reset");
      return;
    default:
      notify(ctx, "Usage: /tools [status|on <names...>|off <names...>|profile <name>|reset]", "warning");
  }
}

async function openToolsTui(pi: ExtensionAPI, ctx: ExtensionCommandContext, config: ResolvedConfig): Promise<void> {
  await ctx.ui.custom((tui, theme, _kb, done) => {
    const locked = new Set(config.alwaysActive);
    const items: SettingItem[] = all(pi).map((tool) => {
      const isLocked = tool.name === SEARCH_TOOL_NAME || locked.has(tool.name);
      return {
        id: tool.name,
        label: tool.name,
        description:
          tool.name === SEARCH_TOOL_NAME
            ? "Always active; keeps missing capabilities searchable."
            : undefined,
        currentValue: pi.getActiveTools().includes(tool.name) ? "enabled" : "disabled",
        values: isLocked ? ["enabled"] : ["enabled", "disabled"],
      };
    });

    const container = new Container();
    container.addChild(
      new (class {
        render(_width: number) {
          return [theme.fg("accent", theme.bold("Tool Manager")), theme.fg("muted", "Search, then Enter/Space to toggle. Changes persist immediately."), ""];
        }
        invalidate() {}
      })(),
    );

    const settingsList = new SettingsList(items, Math.min(items.length + 2, 18), getSettingsListTheme(), (id, newValue) => {
      if ((id === SEARCH_TOOL_NAME || locked.has(id)) && newValue !== "enabled") return;
      const active = new Set(pi.getActiveTools());
      if (newValue === "enabled") active.add(id);
      else active.delete(id);
      active.add(SEARCH_TOOL_NAME);
      for (const name of locked) active.add(name);
      const next = apply(pi, [...active], config);
      persist(pi, next, "toggle");
    }, () => done(undefined), { enableSearch: true });

    container.addChild(settingsList);
    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}

function restoreBranch(pi: ExtensionAPI, ctx: ExtensionContext, config: ResolvedConfig): void {
  const restored = latestStateFromEntries(branchEntries(ctx));
  const next = restored ? setAdditive([], restored.active, config, all(pi)) : profileTools(config.defaultProfile, config, all(pi));
  apply(pi, next, config);
}

export default function toolManager(pi: ExtensionAPI) {
  let config = loadConfig();

  pi.registerTool({
    name: SEARCH_TOOL_NAME,
    label: "Search Tools",
    description: "Find and activate inactive tools by exact name, capability group, or multiple strong terms. Additive only.",
    promptSnippet: "Find and activate tools for capabilities that are not currently available.",
    promptGuidelines: [
      "Use search_tools when a task needs a capability that is not active; search by exact tool name or capability such as code analysis, delegation, skills, catching tests, prior sessions, or web access.",
    ],
    parameters: Type.Object({ query: Type.String({ description: "Tool name, group, or capability terms to activate." }) }),
    async execute(_id, params) {
      const result = searchTools(params.query, pi.getActiveTools(), config, all(pi));
      if (result.loaded.length > 0) {
        const next = setAdditive(pi.getActiveTools(), result.loaded, config, all(pi));
        pi.setActiveTools(next);
        persist(pi, next, "search");
      }
      const text = [`loaded: ${result.loaded.join(", ") || "-"}`, `already-active: ${result.alreadyActive.join(", ") || "-"}`, `no-match: ${result.noMatch ? "true" : "false"}`, `groups: ${result.groups.join(", ") || "-"}`].join("\n");
      return { content: [{ type: "text", text }], details: result };
    },
  });

  pi.registerCommand("tools", { description: "Manage soft tool availability. Usage: /tools [status|on|off|profile|reset]", handler: (args, ctx) => handleToolsCommand(pi, args, ctx, config) });

  pi.on("session_start", (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    restoreBranch(pi, ctx, config);
  });
  pi.on("session_tree", (_event, ctx) => {
    restoreBranch(pi, ctx, config);
  });
  pi.on("input", (event) => {
    const groups = triggerGroups({ text: event.text, source: event.source }, config.autoActivate);
    if (groups.length === 0) return { action: "continue" as const };
    const additions = expandEntries(groups, config, all(pi)).filter((name) => !config.manualOnly.has(name));
    const before = pi.getActiveTools();
    const next = setAdditive(before, additions, config, all(pi));
    if (next.some((name) => !before.includes(name))) {
      pi.setActiveTools(next);
      persist(pi, next, "auto");
    }
    return { action: "continue" as const };
  });
}
