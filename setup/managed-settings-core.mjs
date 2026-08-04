import ts from "typescript";

const DEFAULT_LIGHT_THEME = "gruvbox-light";
const DEFAULT_DARK_THEME = "gruvbox-dark";
const DEFAULT_AUTO_THEME = `${DEFAULT_LIGHT_THEME}/${DEFAULT_DARK_THEME}`;
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

function packageSource(pkg) {
  return typeof pkg === "string" ? pkg : isPlainObject(pkg) ? pkg.source : undefined;
}

function ensurePiUpdateDefault(settings) {
  if (!isPlainObject(settings.piUpdate)) settings.piUpdate = {};
  if (settings.piUpdate.enabled !== true) settings.piUpdate.enabled = false;
}

function ensureDefaultTheme(settings) {
  if (typeof settings.theme !== "string" || settings.theme.trim() === "")
    settings.theme = DEFAULT_AUTO_THEME;
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

export function applyManagedSettingsTransforms(settings, managed, repoPath, packagePath) {
  mergeManaged(settings, managed);
  ensureDefaultTheme(settings);
  migrateDefaultNpmCommand(settings);
  ensurePiUpdateDefault(settings);
  ensureDisabledExtensions(settings);

  if (!Array.isArray(settings.packages)) settings.packages = [];
  settings.packages = settings.packages.filter(
    (pkg) => packageSource(pkg) !== repoPath || repoPath === packagePath,
  );
  if (!settings.packages.some((pkg) => packageSource(pkg) === packagePath))
    settings.packages.push(packagePath);
  return settings;
}

export function renderSettings(settings) {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
