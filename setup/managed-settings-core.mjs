import ts from "typescript";

function stripJsonCommentsAndTrailingCommas(raw) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, raw);
  let output = "";
  let pendingComma = false;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.CommaToken) {
      if (pendingComma) output += ",";
      pendingComma = true;
      continue;
    }
    if (
      pendingComma &&
      token !== ts.SyntaxKind.CloseBraceToken &&
      token !== ts.SyntaxKind.CloseBracketToken
    ) {
      output += ",";
    }
    pendingComma = false;
    output += scanner.getTokenText();
  }
  return output;
}

export function parseJsonRelaxedText(raw) {
  if (raw.trim() === "") return {};
  return JSON.parse(stripJsonCommentsAndTrailingCommas(raw));
}

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
    defaultTools: ["+codemode", "+tool_search"],
    npmCommand: ["nub"],
  };
}

export function renderSettings(settings) {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
