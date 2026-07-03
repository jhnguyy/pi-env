import { readSettingsBlock } from "../_shared/settings";

export type AnthropicHostedToolName = "web_search" | "web_fetch";

export interface AnthropicWebToolSettings {
  enabled: boolean;
  allowWithZdr: boolean;
  tools: AnthropicHostedToolName[];
  maxUses?: number;
}

const DEFAULT_TOOLS: AnthropicHostedToolName[] = ["web_search"];
const TOOL_TYPES: Record<AnthropicHostedToolName, string> = {
  web_search: "web_search_20250305",
  web_fetch: "web_fetch_20250910",
};

export function loadAnthropicWebToolSettings(cwd = process.cwd(), env = process.env): AnthropicWebToolSettings {
  const settings = readSettingsBlock("webContext", cwd);
  const hosted = objectAt(settings, "anthropicHostedTools");
  const legacy = objectAt(settings, "anthropicWebSearch");
  const merged = { ...legacy, ...hosted };

  return {
    enabled: booleanSetting(merged.enabled, env.PI_ANTHROPIC_WEB_TOOLS, true),
    allowWithZdr: booleanSetting(merged.allowWithZdr, env.PI_ANTHROPIC_WEB_TOOLS_ALLOW_ZDR, false),
    tools: parseToolList(merged.tools) ?? DEFAULT_TOOLS,
    maxUses: numberSetting(merged.maxUses),
  };
}

export function shouldInjectAnthropicHostedWebTools(model: unknown, env = process.env, settings = loadAnthropicWebToolSettings()): boolean {
  if (!settings.enabled) return false;
  if (!isAnthropicProviderModel(model)) return false;
  if (isZdrEnabled(env) && !settings.allowWithZdr) return false;
  return true;
}

export function injectAnthropicHostedWebTools(payload: unknown, settings: AnthropicWebToolSettings): unknown {
  if (!isRecord(payload)) return payload;

  const existingTools = Array.isArray(payload.tools) ? [...payload.tools] : [];
  const existingNames = new Set(existingTools.map((tool) => (isRecord(tool) ? tool.name : undefined)).filter((name): name is string => typeof name === "string"));
  const hostedTools = settings.tools
    .filter((name) => !existingNames.has(name))
    .map((name) => buildHostedTool(name, settings));

  if (hostedTools.length === 0) return payload;
  return {
    ...payload,
    tools: [...existingTools, ...hostedTools],
  };
}

export function isZdrEnabled(env = process.env): boolean {
  return [env.ANTHROPIC_ZDR, env.PI_ANTHROPIC_ZDR, env.CLAUDE_ZDR]
    .some((value) => typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim()));
}

function buildHostedTool(name: AnthropicHostedToolName, settings: AnthropicWebToolSettings): Record<string, unknown> {
  return {
    type: TOOL_TYPES[name],
    name,
    ...(name === "web_search" && settings.maxUses !== undefined ? { max_uses: settings.maxUses } : {}),
  };
}

function isAnthropicProviderModel(model: unknown): boolean {
  if (!isRecord(model)) return false;
  return model.provider === "anthropic" || model.api === "anthropic-messages" && model.provider !== "github-copilot";
}

function objectAt(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  return isRecord(value) ? value : {};
}

function booleanSetting(value: unknown, envValue: unknown, defaultValue: boolean): boolean {
  const parsedEnv = parseBoolean(envValue);
  if (parsedEnv !== undefined) return parsedEnv;
  const parsedValue = parseBoolean(value);
  return parsedValue ?? defaultValue;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
  if (/^(0|false|no|off)$/i.test(value.trim())) return false;
  return undefined;
}

function numberSetting(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function parseToolList(value: unknown): AnthropicHostedToolName[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools = value.filter((item): item is AnthropicHostedToolName => item === "web_search" || item === "web_fetch");
  return tools.length > 0 ? [...new Set(tools)] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
