export function initialSettings(auth = {}) {
  const hasAuth = (provider) => ["oauth", "api_key"].includes(auth?.[provider]?.type);
  return {
    defaultProvider: hasAuth("openai")
      ? "openai"
      : hasAuth("openai-codex")
        ? "openai-codex"
        : "openai",
    defaultModel: "gpt-6.1-sol",
    defaultThinkingLevel: "medium",
    theme: "gruvbox-light/gruvbox-dark",
    defaultTools: ["+codemode", "+tool_search"],
    npmCommand: ["nub"],
  };
}

// Reapplied on every setup run. Provider timeouts cover only the wait for response headers;
// httpIdleTimeoutMs bounds mid-stream stalls. Both surface as retryable timeouts.
export const managedSettings = {
  httpIdleTimeoutMs: 120000,
  retry: {
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 7500,
    provider: { timeoutMs: 30000, maxRetries: 0, maxRetryDelayMs: 60000 },
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function applyManagedSettings(settings, managed = managedSettings) {
  const result = { ...settings };
  for (const [key, value] of Object.entries(managed)) {
    result[key] = isPlainObject(value)
      ? applyManagedSettings(isPlainObject(result[key]) ? result[key] : {}, value)
      : value;
  }
  return result;
}

export function renderSettings(settings) {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
