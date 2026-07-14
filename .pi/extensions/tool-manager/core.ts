import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";

export const ToolManagerSettingsSchema = Schema.Struct({
  defaultProfile: Schema.optional(Schema.String),
  profiles: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  groups: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  alwaysActive: Schema.optional(Schema.Array(Schema.String)),
  manualOnly: Schema.optional(Schema.Array(Schema.String)),
  autoActivate: Schema.optional(Schema.Boolean),
});
export type ToolManagerSettings = typeof ToolManagerSettingsSchema.Type;

export const SEARCH_TOOL_NAME = "search_tools";
export const CUSTOM_TYPE = "tool-manager:state";

export const DEFAULT_GROUPS: Record<string, string[]> = {
  analysis: ["analyze"],
  delegation: ["subagent", "subagent_start", "subagent_job"],
  skills: ["reference_skill", "skill_build"],
  "catching-tests": ["jit_catch"],
  sessions: ["list_sessions", "read_session"],
  web: ["web_context", "web_fetch"],
};

export const GROUP_HINTS: Record<string, RegExp[]> = {
  analysis: [/\banalys(is|e|ze|ing)\b/, /\bcomplexity\b/, /\bduplicates?\b/, /\basync[- ]?risk\b/, /\bstatic checks?\b/],
  delegation: [/\bdelegat(e|ion)\b/, /\bsubagents?\b/, /\bbackground agents?\b/, /\bparallel agents?\b/],
  skills: [/\bskills?\b/],
  "catching-tests": [/\bcatching\b/, /\bjit[- ]?catch\b/],
  sessions: [/\bsessions?\b/, /\bconversation history\b/],
  web: [/\bweb\b/, /\bhttps?:\/\//, /\burl\b/, /\bwebsite\b/],
};

export const CORE_PROFILE = ["read", "bash", "edit", "write", "dev-tools", "ptc", SEARCH_TOOL_NAME];
export const DEFAULT_PROFILES: Record<string, string[]> = {
  core: CORE_PROFILE,
  coding: [...CORE_PROFILE, "analysis", "delegation", "catching-tests"],
  full: ["*"],
};

export interface ResolvedConfig {
  defaultProfile: string;
  profiles: Record<string, string[]>;
  groups: Record<string, string[]>;
  alwaysActive: string[];
  manualOnly: Set<string>;
  autoActivate: boolean;
}

export interface StateEntry {
  profile?: string;
  active: string[];
  reason: "profile" | "toggle" | "auto" | "search" | "reset";
  at: string;
}

export function resolveConfig(settings: ToolManagerSettings = {}): ResolvedConfig {
  const profiles = mutableRecord({ ...DEFAULT_PROFILES, ...(settings.profiles ?? {}) });
  const defaultProfile = settings.defaultProfile && profiles[settings.defaultProfile] ? settings.defaultProfile : "core";
  return {
    defaultProfile,
    profiles,
    groups: mutableRecord({ ...DEFAULT_GROUPS, ...(settings.groups ?? {}) }),
    alwaysActive: unique([SEARCH_TOOL_NAME, ...(settings.alwaysActive ?? [])]),
    manualOnly: new Set(settings.manualOnly ?? []),
    autoActivate: settings.autoActivate ?? true,
  };
}

function mutableRecord(record: Record<string, readonly string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, [...value]]));
}

export function unique(names: readonly string[]): string[] {
  return [...new Set(names.filter(Boolean))];
}

export function registeredNames(tools: readonly Pick<ToolInfo, "name">[]): Set<string> {
  return new Set(tools.map((t) => t.name));
}

export function unknownEntries(entries: readonly string[], config: ResolvedConfig, allTools: readonly Pick<ToolInfo, "name">[]): string[] {
  const all = registeredNames(allTools);
  return unique(entries.filter((entry) => entry !== "*" && !config.groups[entry] && !all.has(entry)));
}

export function expandRequestedEntries(entries: readonly string[], config: ResolvedConfig, allTools: readonly Pick<ToolInfo, "name">[]): string[] {
  const all = registeredNames(allTools);
  const expanded: string[] = [];
  for (const entry of entries) {
    if (entry === "*") expanded.push(...[...all].sort());
    else if (config.groups[entry]) expanded.push(...config.groups[entry]);
    else expanded.push(entry);
  }
  return unique(expanded).filter((name) => all.has(name));
}

function withLockedTools(names: readonly string[], config: ResolvedConfig, allTools: readonly Pick<ToolInfo, "name">[]): string[] {
  const all = registeredNames(allTools);
  return unique([...names, SEARCH_TOOL_NAME, ...config.alwaysActive]).filter((name) => all.has(name));
}

export function expandEntries(entries: readonly string[], config: ResolvedConfig, allTools: readonly Pick<ToolInfo, "name">[]): string[] {
  return withLockedTools(expandRequestedEntries(entries, config, allTools), config, allTools);
}

export function profileTools(profile: string, config: ResolvedConfig, allTools: readonly Pick<ToolInfo, "name">[]): string[] {
  if (!(profile in config.profiles)) return [];
  return withLockedTools(expandRequestedEntries(config.profiles[profile] ?? [], config, allTools), config, allTools);
}

export function setAdditive(active: readonly string[], additions: readonly string[], config: ResolvedConfig, allTools: readonly Pick<ToolInfo, "name">[]): string[] {
  return withLockedTools([...active, ...additions], config, allTools);
}

function normalize(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9_-]+/).filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

const STOP_WORDS = new Set(["a", "an", "and", "the", "this", "that", "for", "with", "tool", "tools", "use", "run", "do", "please"]);

export function searchTools(query: string, active: readonly string[], config: ResolvedConfig, allTools: readonly ToolInfo[]) {
  const q = query.trim().toLowerCase();
  const terms = normalize(query);
  const groups = Object.entries(config.groups).filter(([group]) => terms.includes(group) || (GROUP_HINTS[group] ?? []).some((rx) => rx.test(q)));
  const wanted = new Set<string>(groups.flatMap(([, names]) => names));
  const hasGroupHint = groups.length > 0;

  for (const tool of allTools) {
    const name = tool.name.toLowerCase();
    if (q === name) {
      wanted.add(tool.name);
      continue;
    }
    if (config.manualOnly.has(tool.name)) continue;
    if (!hasGroupHint) {
      const descriptionTerms = normalize(tool.description ?? "");
      const hits = terms.filter((term) => name.split(/[_-]/).includes(term) || descriptionTerms.includes(term));
      if (hits.length >= 2) wanted.add(tool.name);
    }
  }

  for (const name of config.manualOnly) wanted.delete(name);
  const available = new Set(allTools.map((t) => t.name));
  const matches = [...wanted].filter((name) => available.has(name)).sort();
  const activeSet = new Set(active);
  const loaded = matches.filter((name) => !activeSet.has(name));
  return { loaded, alreadyActive: matches.filter((name) => activeSet.has(name)), noMatch: matches.length === 0, groups: groups.map(([name]) => name).sort() };
}

export function triggerGroups(input: { text: string; source?: string }, autoActivate: boolean): string[] {
  if (!autoActivate || input.source === "extension") return [];
  const t = input.text.toLowerCase();
  const groups: string[] = [];
  const codingAction = /\b(fix|implement|edit|write|refactor|debug|review|change|patch|update|build|test|analy[sz]e)\b/.test(t);
  const codeEntity = /\b(code|repo|repository|file|files|diff|worktree|pr|ci|\.([cm]?[jt]sx?|py|rs|go|java|sh|md|json|ya?ml|toml))\b/.test(t);
  if (/\b(static checks?|code analysis|complexity|async-risk|duplicates? check)\b/.test(t) || (codingAction && codeEntity)) groups.push("analysis");
  if (/\b(delegate|delegation|subagent|parallel agents?|background agent|start a subagent)\b/.test(t)) groups.push("delegation");
  if (/\b(create|build|review|reference) (a )?skill\b|\bskill (create|build|review|reference)\b/.test(t)) groups.push("skills");
  if (/\b(catching|jit[- ]?catch)\b/.test(t)) groups.push("catching-tests");
  if (/\b(prior|previous|past) (session|conversation)\b|\bsession history\b/.test(t)) groups.push("sessions");
  if (/https?:\/\/\S+|\b(web fetch|fetch (the )?(website|url|page)|website context)\b/.test(t)) groups.push("web");
  return unique(groups);
}

export function latestStateFromEntries(entries: readonly unknown[]): StateEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (typeof entry === "object" && entry !== null && "customType" in entry && (entry as { customType?: unknown }).customType === CUSTOM_TYPE) {
      const data = (entry as { data?: unknown; details?: unknown }).data ?? (entry as { details?: unknown }).details;
      if (typeof data === "object" && data !== null && Array.isArray((data as { active?: unknown }).active)) return data as StateEntry;
    }
  }
  return undefined;
}
