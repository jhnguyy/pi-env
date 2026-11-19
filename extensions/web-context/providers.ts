import type { Api, Model } from "@earendil-works/pi-ai";
import { Schema } from "effect";
import { booleanSetting, decodeSettingsBlockSync, isObject } from "../_shared/settings";

// Keep the persisted settings keys, not the old conversation-tool injection path.
const OpenAISettings = Schema.Struct({
  openaiHostedTools: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      searchContextSize: Schema.optionalKey(Schema.Literals(["low", "medium", "high"])),
      externalWebAccess: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const AnthropicSettings = Schema.Struct({
  anthropicHostedTools: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      tools: Schema.optionalKey(Schema.Array(Schema.Literals(["web_search", "web_fetch"]))),
      maxUses: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
    }),
  ),
});

function openAISearchTool(cwd: string): Record<string, unknown> {
  const settings =
    decodeSettingsBlockSync("webContext", OpenAISettings, cwd).openaiHostedTools ?? {};
  if (!booleanSetting(settings.enabled, process.env.PI_OPENAI_WEB_TOOLS, true)) {
    throw new Error("Web search is disabled by openaiHostedTools.enabled or PI_OPENAI_WEB_TOOLS.");
  }
  return {
    type: "web_search",
    search_context_size: settings.searchContextSize ?? "low",
    ...(settings.externalWebAccess !== undefined
      ? { external_web_access: settings.externalWebAccess }
      : {}),
  };
}

function anthropicSearchTool(cwd: string): Record<string, unknown> {
  const settings =
    decodeSettingsBlockSync("webContext", AnthropicSettings, cwd).anthropicHostedTools ?? {};
  if (
    !booleanSetting(settings.enabled, process.env.PI_ANTHROPIC_WEB_TOOLS, true) ||
    (settings.tools && !settings.tools.includes("web_search"))
  ) {
    throw new Error(
      "Web search is disabled by anthropicHostedTools settings or PI_ANTHROPIC_WEB_TOOLS.",
    );
  }
  return {
    type: "web_search_20250305",
    name: "web_search",
    ...(settings.maxUses !== undefined ? { max_uses: settings.maxUses } : {}),
  };
}

export function searchPayload(model: Model<Api>, cwd: string): (payload: unknown) => unknown {
  const unsupported = () => new Error(`Web search is not supported for ${model.provider}.`);
  if (model.provider === "github-copilot") throw unsupported();
  const anthropic = model.api === "anthropic-messages";
  if (
    !anthropic &&
    !["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(model.api)
  ) {
    throw unsupported();
  }
  const tool = anthropic ? anthropicSearchTool(cwd) : openAISearchTool(cwd);
  return (payload) => {
    if (!isObject(payload)) throw new Error("Invalid provider search payload");
    return {
      ...payload,
      tools: [tool],
      ...(!anthropic
        ? {
            tool_choice: { type: "web_search" },
            include: [
              ...new Set([
                ...(Array.isArray(payload.include) ? payload.include : []),
                "web_search_call.action.sources",
              ]),
            ],
          }
        : {}),
    };
  };
}
