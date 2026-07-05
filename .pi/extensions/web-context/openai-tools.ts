import { booleanSetting, isObject, objectAt, parseBooleanSetting, readSettingsBlock } from "../_shared/settings";

export const OpenAIHostedToolName = {
  WebSearch: "web_search",
} as const;
export type OpenAIHostedToolName = typeof OpenAIHostedToolName[keyof typeof OpenAIHostedToolName];

export const OpenAISearchContextSize = {
  Low: "low",
  Medium: "medium",
  High: "high",
} as const;
export type OpenAISearchContextSize = typeof OpenAISearchContextSize[keyof typeof OpenAISearchContextSize];

const WebContextSettingKey = {
  Root: "webContext",
  HostedTools: "openaiHostedTools",
} as const;

const OpenAIHostedToolSettingKey = {
  Enabled: "enabled",
  SearchContextSize: "searchContextSize",
  ExternalWebAccess: "externalWebAccess",
} as const;

const OpenAIHostedToolEnvVar = {
  Enabled: "PI_OPENAI_WEB_TOOLS",
} as const;

const ProviderName = {
  OpenAI: "openai",
  OpenAICodex: "openai-codex",
  GitHubCopilot: "github-copilot",
} as const;

const ModelApi = {
  OpenAIResponses: "openai-responses",
  OpenAICodexResponses: "openai-codex-responses",
  AzureOpenAIResponses: "azure-openai-responses",
} as const;

export interface OpenAIWebToolSettings {
  enabled: boolean;
  searchContextSize?: OpenAISearchContextSize;
  externalWebAccess?: boolean;
}

export function loadOpenAIWebToolSettings(cwd = process.cwd(), env: Record<string, string | undefined> = process.env): OpenAIWebToolSettings {
  const settings = objectAt(readSettingsBlock(WebContextSettingKey.Root, cwd), WebContextSettingKey.HostedTools);

  return {
    enabled: booleanSetting(settings[OpenAIHostedToolSettingKey.Enabled], env[OpenAIHostedToolEnvVar.Enabled], true),
    searchContextSize: searchContextSizeSetting(settings[OpenAIHostedToolSettingKey.SearchContextSize]) ?? OpenAISearchContextSize.Low,
    externalWebAccess: parseBooleanSetting(settings[OpenAIHostedToolSettingKey.ExternalWebAccess]),
  };
}

export function isOpenAIHostedWebToolsModel(model: unknown): boolean {
  return isOpenAIResponsesModel(model) && isOpenAIWebSearchCapableModel(model);
}

export function shouldInjectOpenAIHostedWebTools(model: unknown, settings = loadOpenAIWebToolSettings()): boolean {
  return settings.enabled && isOpenAIHostedWebToolsModel(model);
}

export function injectOpenAIHostedWebTools(payload: unknown, settings: OpenAIWebToolSettings): unknown {
  if (!isObject(payload)) return payload;

  const existingTools = Array.isArray(payload.tools) ? [...payload.tools] : [];
  const hasWebSearch = existingTools.some((tool) => isObject(tool) && (tool.type === OpenAIHostedToolName.WebSearch || tool.name === OpenAIHostedToolName.WebSearch));
  if (hasWebSearch) return payload;

  return { ...payload, tools: [...existingTools, buildWebSearchTool(settings)] };
}

function buildWebSearchTool(settings: OpenAIWebToolSettings): Record<string, unknown> {
  return {
    type: OpenAIHostedToolName.WebSearch,
    ...(settings.searchContextSize ? { search_context_size: settings.searchContextSize } : {}),
    ...(settings.externalWebAccess !== undefined ? { external_web_access: settings.externalWebAccess } : {}),
  };
}

function isOpenAIResponsesModel(model: unknown): boolean {
  if (!isObject(model)) return false;
  if (model.provider === ProviderName.GitHubCopilot) return false;
  if (model.api !== undefined) {
    return model.api === ModelApi.OpenAIResponses || model.api === ModelApi.OpenAICodexResponses || model.api === ModelApi.AzureOpenAIResponses;
  }
  return model.provider === ProviderName.OpenAI || model.provider === ProviderName.OpenAICodex;
}

function isOpenAIWebSearchCapableModel(model: unknown): boolean {
  if (!isObject(model)) return false;
  const id = typeof model.id === "string" ? model.id : "";
  return id === "gpt-5.5" || id.startsWith("gpt-5.5-");
}

function searchContextSizeSetting(value: unknown): OpenAISearchContextSize | undefined {
  return typeof value === "string" && Object.values(OpenAISearchContextSize).includes(value as OpenAISearchContextSize) ? (value as OpenAISearchContextSize) : undefined;
}
