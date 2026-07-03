import { readSettingsBlock } from "../_shared/settings";

export enum AnthropicHostedToolName {
  WebSearch = "web_search",
  WebFetch = "web_fetch",
}

enum AnthropicHostedToolType {
  WebSearch = "web_search_20250305",
  WebFetch = "web_fetch_20250910",
}

enum WebContextSettingKey {
  Root = "webContext",
  HostedTools = "anthropicHostedTools",
}

enum AnthropicHostedToolSettingKey {
  Enabled = "enabled",
  AllowWithZdr = "allowWithZdr",
  Tools = "tools",
  MaxUses = "maxUses",
}

enum ZdrEnvVar {
  Anthropic = "ANTHROPIC_ZDR",
  PiAnthropic = "PI_ANTHROPIC_ZDR",
  Claude = "CLAUDE_ZDR",
}

enum AnthropicHostedToolEnvVar {
  Enabled = "PI_ANTHROPIC_WEB_TOOLS",
  AllowWithZdr = "PI_ANTHROPIC_WEB_TOOLS_ALLOW_ZDR",
}

enum ProviderName {
  Anthropic = "anthropic",
  GitHubCopilot = "github-copilot",
}

enum ModelApi {
  AnthropicMessages = "anthropic-messages",
}

export interface AnthropicWebToolSettings {
  enabled: boolean;
  allowWithZdr: boolean;
  tools: AnthropicHostedToolName[];
  maxUses?: number;
}

const DEFAULT_TOOLS = [AnthropicHostedToolName.WebSearch] as const;
const TOOL_TYPES: Record<AnthropicHostedToolName, AnthropicHostedToolType> = {
  [AnthropicHostedToolName.WebSearch]: AnthropicHostedToolType.WebSearch,
  [AnthropicHostedToolName.WebFetch]: AnthropicHostedToolType.WebFetch,
};

export function loadAnthropicWebToolSettings(cwd = process.cwd(), env: Record<string, string | undefined> = process.env): AnthropicWebToolSettings {
  const settings = objectAt(readSettingsBlock(WebContextSettingKey.Root, cwd), WebContextSettingKey.HostedTools);

  return {
    enabled: booleanSetting(settings[AnthropicHostedToolSettingKey.Enabled], env[AnthropicHostedToolEnvVar.Enabled], true),
    allowWithZdr: booleanSetting(settings[AnthropicHostedToolSettingKey.AllowWithZdr], env[AnthropicHostedToolEnvVar.AllowWithZdr], false),
    tools: parseToolList(settings[AnthropicHostedToolSettingKey.Tools]) ?? [...DEFAULT_TOOLS],
    maxUses: numberSetting(settings[AnthropicHostedToolSettingKey.MaxUses]),
  };
}

export function shouldInjectAnthropicHostedWebTools(
  model: unknown,
  env: Record<string, string | undefined> = process.env,
  settings = loadAnthropicWebToolSettings(),
): boolean {
  return settings.enabled && isAnthropicProviderModel(model) && (!isZdrEnabled(env) || settings.allowWithZdr);
}

export function injectAnthropicHostedWebTools(payload: unknown, settings: AnthropicWebToolSettings): unknown {
  if (!isRecord(payload)) return payload;

  const existingTools = Array.isArray(payload.tools) ? [...payload.tools] : [];
  const existingNames = new Set(
    existingTools
      .map((tool) => (isRecord(tool) ? tool.name : undefined))
      .filter((name): name is string => typeof name === "string"),
  );
  const hostedTools = settings.tools
    .filter((name) => !existingNames.has(name))
    .map((name) => buildHostedTool(name, settings));

  return hostedTools.length === 0 ? payload : { ...payload, tools: [...existingTools, ...hostedTools] };
}

export function isZdrEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return Object.values(ZdrEnvVar).some((name) => parseBoolean(env[name]) === true);
}

function buildHostedTool(name: AnthropicHostedToolName, settings: AnthropicWebToolSettings): Record<string, unknown> {
  return {
    type: TOOL_TYPES[name],
    name,
    ...(name === AnthropicHostedToolName.WebSearch && settings.maxUses !== undefined ? { max_uses: settings.maxUses } : {}),
  };
}

function isAnthropicProviderModel(model: unknown): boolean {
  if (!isRecord(model)) return false;
  return model.provider === ProviderName.Anthropic || (model.api === ModelApi.AnthropicMessages && model.provider !== ProviderName.GitHubCopilot);
}

function objectAt(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  return isRecord(value) ? value : {};
}

function booleanSetting(value: unknown, envValue: unknown, defaultValue: boolean): boolean {
  return parseBoolean(envValue) ?? parseBoolean(value) ?? defaultValue;
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
  const tools = value.filter((item): item is AnthropicHostedToolName => Object.values(AnthropicHostedToolName).includes(item));
  return tools.length > 0 ? [...new Set(tools)] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
