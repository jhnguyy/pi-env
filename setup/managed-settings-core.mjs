import ts from "typescript";

const RETIRED_PACKAGE_THEMES = new Set(["gruvbox-light", "gruvbox-dark", "gruvbox-light/gruvbox-dark"]);
const NATIVE_TOOL_DEFAULTS = ["+codemode", "+tool_search"];
const DISABLED_EXTENSIONS = ["playwright-client", "work-tracker"];

function stripJsonCommentsAndTrailingCommas(raw) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    raw,
  );
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

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeManaged(target, managed) {
  for (const [key, value] of Object.entries(managed)) {
    if (key.startsWith("_comment")) continue;
    if (isPlainObject(value) && isPlainObject(target[key])) mergeManaged(target[key], value);
    else target[key] = value;
  }
  return target;
}

function ensurePiUpdateDefault(settings) {
  if (!isPlainObject(settings.piUpdate)) settings.piUpdate = {};
  if (settings.piUpdate.enabled !== true) settings.piUpdate.enabled = false;
}

function adoptNativeDefaults(settings) {
  if (RETIRED_PACKAGE_THEMES.has(settings.theme) || (typeof settings.theme === "string" && settings.theme.trim() === ""))
    delete settings.theme;
  if (!Array.isArray(settings.defaultTools)) settings.defaultTools = [];
  for (const entry of NATIVE_TOOL_DEFAULTS) {
    const name = entry.slice(1);
    if (!settings.defaultTools.some((configured) => configured === name || configured === `+${name}` || configured === `-${name}`))
      settings.defaultTools.push(entry);
  }
}

function migrateDefaultNpmCommand(settings) {
  if (
    Array.isArray(settings.npmCommand) &&
    settings.npmCommand.length === 1 &&
    settings.npmCommand[0] === "npm"
  )
    settings.npmCommand = ["nub"];
}

function ensureDisabledExtensions(settings) {
  const existing = Array.isArray(settings.extensions) ? settings.extensions : [];
  settings.extensions = [
    ...existing.filter(
      (entry) =>
        !DISABLED_EXTENSIONS.some(
          (name) =>
            entry === name ||
            entry === `extensions/${name}` ||
            entry === `.pi/extensions/${name}` ||
            entry === `-${name}`,
        ),
    ),
    ...DISABLED_EXTENSIONS.map((name) => `-${name}`),
  ];
}

export function applyManagedSettingsTransforms(settings, managed) {
  mergeManaged(settings, managed);
  adoptNativeDefaults(settings);
  migrateDefaultNpmCommand(settings);
  ensurePiUpdateDefault(settings);
  ensureDisabledExtensions(settings);
  if (!Array.isArray(settings.packages)) settings.packages = [];
  return settings;
}

export function renderSettings(settings) {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
