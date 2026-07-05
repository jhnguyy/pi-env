import { booleanSetting, isObject, objectAt, positiveIntegerSetting, readSettingsBlock } from "../_shared/settings";

export const AnthropicHostedToolName = {
  WebSearch: "web_search",
  WebFetch: "web_fetch",
} as const;
export type AnthropicHostedToolName = typeof AnthropicHostedToolName[keyof typeof AnthropicHostedToolName];

const AnthropicHostedToolType = {
  WebSearch: "web_search_20250305",
  WebFetch: "web_fetch_20250910",
} as const;
type AnthropicHostedToolType = typeof AnthropicHostedToolType[keyof typeof AnthropicHostedToolType];

const WebContextSettingKey = {
  Root: "webContext",
  HostedTools: "anthropicHostedTools",
} as const;
type WebContextSettingKey = typeof WebContextSettingKey[keyof typeof WebContextSettingKey];

const AnthropicHostedToolSettingKey = {
  Enabled: "enabled",
  Tools: "tools",
  MaxUses: "maxUses",
} as const;
type AnthropicHostedToolSettingKey = typeof AnthropicHostedToolSettingKey[keyof typeof AnthropicHostedToolSettingKey];

const AnthropicHostedToolEnvVar = {
  Enabled: "PI_ANTHROPIC_WEB_TOOLS",
} as const;
type AnthropicHostedToolEnvVar = typeof AnthropicHostedToolEnvVar[keyof typeof AnthropicHostedToolEnvVar];

const ProviderName = {
  Anthropic: "anthropic",
  GitHubCopilot: "github-copilot",
} as const;
type ProviderName = typeof ProviderName[keyof typeof ProviderName];

const ModelApi = {
  AnthropicMessages: "anthropic-messages",
} as const;
type ModelApi = typeof ModelApi[keyof typeof ModelApi];

export interface AnthropicWebToolSettings {
  enabled: boolean;
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
    tools: parseToolList(settings[AnthropicHostedToolSettingKey.Tools]) ?? [...DEFAULT_TOOLS],
    maxUses: positiveIntegerSetting(settings[AnthropicHostedToolSettingKey.MaxUses]),
  };
}

export function isAnthropicHostedWebToolsModel(model: unknown): boolean {
  return isAnthropicProviderModel(model);
}

export function shouldInjectAnthropicHostedWebTools(model: unknown, settings = loadAnthropicWebToolSettings()): boolean {
  return settings.enabled && isAnthropicHostedWebToolsModel(model);
}

export function injectAnthropicHostedWebTools(payload: unknown, settings: AnthropicWebToolSettings): unknown {
  if (!isObject(payload)) return payload;

  const existingTools = Array.isArray(payload.tools) ? [...payload.tools] : [];
  const existingNames = new Set(
    existingTools
      .map((tool) => (isObject(tool) ? tool.name : undefined))
      .filter((name): name is string => typeof name === "string"),
  );
  const hostedTools = settings.tools
    .filter((name) => !existingNames.has(name))
    .map((name) => buildHostedTool(name, settings));

  return hostedTools.length === 0 ? payload : { ...payload, tools: [...existingTools, ...hostedTools] };
}

function buildHostedTool(name: AnthropicHostedToolName, settings: AnthropicWebToolSettings): Record<string, unknown> {
  return {
    type: TOOL_TYPES[name],
    name,
    ...(name === AnthropicHostedToolName.WebSearch && settings.maxUses !== undefined ? { max_uses: settings.maxUses } : {}),
  };
}

function isAnthropicProviderModel(model: unknown): boolean {
  if (!isObject(model)) return false;
  return model.provider === ProviderName.Anthropic || (model.api === ModelApi.AnthropicMessages && model.provider !== ProviderName.GitHubCopilot);
}

function parseToolList(value: unknown): AnthropicHostedToolName[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools = value.filter((item): item is AnthropicHostedToolName => Object.values(AnthropicHostedToolName).includes(item));
  return tools.length > 0 ? [...new Set(tools)] : undefined;
}

