const { readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

const extensionRoot = ".pi/extensions";
const extensionNames = readdirSync(extensionRoot)
  .filter((name) => name !== "_shared")
  .filter((name) => statSync(join(extensionRoot, name)).isDirectory())
  .sort();

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  forbidden: [
    ...extensionNames.map((name) => ({
      name: `${name}-no-cross-extension-imports`,
      severity: "error",
      comment: "Extensions should depend on their own files or _shared only; cross-extension reuse belongs in _shared so load order and package boundaries stay explicit.",
      from: { path: `^\\.pi/extensions/${escapeRegex(name)}/` },
      to: { path: `^\\.pi/extensions/(?!(_shared|${escapeRegex(name)})/)` },
    })),
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    exclude: {
      path: "(^|/)dist/|(^|/)__tests__/",
    },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
