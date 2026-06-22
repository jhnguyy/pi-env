#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [settingsFile, managedSettingsFile, repoPath] = process.argv.slice(2);
const DEFAULT_LIGHT_THEME = "gruvbox-light";
const DEFAULT_DARK_THEME = "gruvbox-dark";
const DEFAULT_AUTO_THEME = `${DEFAULT_LIGHT_THEME}/${DEFAULT_DARK_THEME}`;

if (!settingsFile || !managedSettingsFile || !repoPath) {
  console.error("usage: apply-managed-settings.mjs <settings-file> <managed-settings-file> <repo-path>");
  process.exit(2);
}

function stripJsonComments(input) {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (ch === "\n" || ch === "\r") {
        inLineComment = false;
        output += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      output += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      output += ch;
    } else if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
    } else if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
    } else {
      output += ch;
    }
  }

  return output;
}

function stripTrailingCommas(input) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (inString) {
      output += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      output += ch;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j += 1;
      if (input[j] === "}" || input[j] === "]") {
        continue;
      }
    }

    output += ch;
  }

  return output;
}

function parseJsonRelaxed(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(stripTrailingCommas(stripJsonComments(raw)));
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeManaged(target, managed) {
  for (const [key, value] of Object.entries(managed)) {
    if (key.startsWith("_comment")) continue;
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeManaged(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function packageSource(pkg) {
  return typeof pkg === "string" ? pkg : isPlainObject(pkg) ? pkg.source : undefined;
}

function ensurePiUpdateDefault(settings) {
  if (!isPlainObject(settings.piUpdate)) {
    settings.piUpdate = {};
  }
  if (settings.piUpdate.enabled !== true) {
    settings.piUpdate.enabled = false;
  }
}

function ensureDefaultTheme(settings) {
  if (typeof settings.theme !== "string" || settings.theme.trim() === "") {
    settings.theme = DEFAULT_AUTO_THEME;
  }
}

function migrateDefaultNpmCommand(settings) {
  if (Array.isArray(settings.npmCommand) && settings.npmCommand.length === 1 && settings.npmCommand[0] === "npm") {
    settings.npmCommand = ["bun"];
  }
}

const before = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : "";
const settings = parseJsonRelaxed(settingsFile);
const managed = parseJsonRelaxed(managedSettingsFile);

mergeManaged(settings, managed);
ensureDefaultTheme(settings);
migrateDefaultNpmCommand(settings);
ensurePiUpdateDefault(settings);

if (!Array.isArray(settings.packages)) {
  settings.packages = [];
}
if (!settings.packages.some((pkg) => packageSource(pkg) === repoPath)) {
  settings.packages.push(repoPath);
}

const after = `${JSON.stringify(settings, null, 2)}\n`;
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
if (before !== after) {
  fs.writeFileSync(settingsFile, after);
  console.log(before ? "updated" : "created");
} else {
  console.log("unchanged");
}
