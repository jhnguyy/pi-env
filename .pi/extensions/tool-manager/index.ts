import {
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Effect } from "effect";
import { decodeSettingsBlockEffect } from "../_shared/settings";
import { registerPtcTools } from "../_shared/ptc-tools";
import {
  CUSTOM_TYPE,
  SEARCH_TOOL_NAME,
  ToolManagerSettingsSchema,
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

interface ToolTransition {
  base?: readonly string[];
  add?: readonly string[];
  remove?: readonly string[];
  profile?: string;
  reason?: "profile" | "toggle" | "auto" | "search" | "reset";
  onlyIfAdded?: boolean;
}

function commitTools(pi: ExtensionAPI, config: ResolvedConfig, transition: ToolTransition): string[] {
  const tools = all(pi);
  const base = transition.profile ? profileTools(transition.profile, config, tools) : transition.base ?? pi.getActiveTools();
  const additions = expandRequestedEntries(transition.add ?? [], config, tools);
  const removals = new Set(expandRequestedEntries(transition.remove ?? [], config, tools).filter((name) => !config.alwaysActive.includes(name)));
  const next = setAdditive(
    base.filter((name) => !removals.has(name)),
    additions,
    config,
    tools,
  );
  if (transition.onlyIfAdded && !next.some((name) => !base.includes(name))) return next;
  pi.setActiveTools(next);
  if (transition.reason) persist(pi, next, transition.reason, transition.profile);
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
  const unknown = unknownEntries(names, config, all(pi));
  const before = new Set(pi.getActiveTools());
  const next = commitTools(pi, config, { add: names, reason: "toggle" });
  notifyChanges(ctx, "Enabled", next.filter((name) => !before.has(name)), unknown);
}

function disableTools(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: ResolvedConfig,
  names: readonly string[],
): void {
  const unknown = unknownEntries(names, config, all(pi));
  const before = pi.getActiveTools();
  const next = commitTools(pi, config, { remove: names, reason: "toggle" });
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
  const next = commitTools(pi, config, { profile, reason });
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
  await ctx.ui.custom((tui, _theme, _kb, done) => {
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

    const settingsList = new SettingsList(items, Math.min(items.length + 2, 18), getSettingsListTheme(), (id, newValue) => {
      if ((id === SEARCH_TOOL_NAME || locked.has(id)) && newValue !== "enabled") return;
      commitTools(pi, config, newValue === "enabled" ? { add: [id], reason: "toggle" } : { remove: [id], reason: "toggle" });
    }, () => done(undefined), { enableSearch: true });

    return {
      render(width: number) {
        return settingsList.render(width);
      },
      invalidate() {
        settingsList.invalidate();
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
  commitTools(pi, config, restored ? { base: [], add: restored.active } : { profile: config.defaultProfile });
}

export default function toolManager(pi: ExtensionAPI) {
  let config = loadConfig();

  const searchTool = defineTool({
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
      if (result.loaded.length > 0) commitTools(pi, config, { add: result.loaded, reason: "search" });
      const text = [`loaded: ${result.loaded.join(", ") || "-"}`, `already-active: ${result.alreadyActive.join(", ") || "-"}`, `no-match: ${result.noMatch ? "true" : "false"}`, `groups: ${result.groups.join(", ") || "-"}`].join("\n");
      return { content: [{ type: "text", text }], details: result };
    },
  });
  registerPtcTools(pi, searchTool);

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
    const additions = expandRequestedEntries(groups, config, all(pi)).filter((name) => !config.manualOnly.has(name));
    commitTools(pi, config, { add: additions, reason: "auto", onlyIfAdded: true });
    return { action: "continue" as const };
  });
}
