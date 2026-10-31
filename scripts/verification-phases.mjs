import { globSync } from "node:fs";

const phase = (id, label, command, args) => ({ id, label, command, args });
const script = (id, label, name, ...args) => phase(id, label, "nub", ["run", name, ...args]);

// Full verification is deliberately independent of Git and valid in an image source snapshot.
export const FULL_VERIFICATION_PHASES = [
  script("format-check", "format check", "format:check"),
  script("pattern-check", "pattern guardrails", "check:patterns"),
  script("dependency-check", "dependency policy", "check:dependencies"),
  script("license-compliance", "license compliance", "licenses:check"),
  script("typecheck", "typecheck", "typecheck"),
  script("type-aware-lint", "type-aware lint", "lint:type"),
  script("build", "extension build", "build"),
  script("setup-tests", "setup tests", "test:setup"),
  script("runtime-tests", "runtime tests", "test"),
  script("install-readiness", "install readiness", "verify:install"),
  script(
    "native-tool-discovery",
    "built extension workflows",
    "test:e2e",
    ".pi/extensions/__tests__/e2e.test.ts",
    ".pi/extensions/subagent/__tests__/e2e.test.ts",
    ".pi/extensions/dev-tools/__tests__/e2e.test.ts",
    ".pi/extensions/share/__tests__/e2e.test.ts",
  ),
];
const canary = script(
  "real-workspace-semantic-canary",
  "real workspace semantic canary",
  "test",
  "--project",
  "real-workspace-canary",
);
export const EXPLICIT_VERIFICATION_PHASES = [...FULL_VERIFICATION_PHASES, canary];
export const verificationPhaseById = (id) =>
  EXPLICIT_VERIFICATION_PHASES.find((entry) => entry.id === id);

const codeFile = (file) => /\.[cm]?[jt]sx?$/.test(file);
const formattable = (file) => /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|md|css|html)$/.test(file);
function owner(file) {
  if (file.startsWith(".pi/extensions/_shared/")) return ".pi/extensions";
  return /^(\.pi\/extensions\/[^/]+|src\/[^/]+|scripts|setup)\//.exec(file)?.[1];
}

export function changedVerificationPlan(change, { checksOnly = false, cwd = process.cwd() } = {}) {
  const phases = [];
  const addBatches = (id, label, command, args, files) => {
    for (let offset = 0; offset < files.length; offset += 128) {
      phases.push(
        phase(`${id}-${offset / 128 + 1}`, label, command, [
          ...args,
          ...files.slice(offset, offset + 128),
        ]),
      );
    }
  };
  const source = change.existing.filter(codeFile);
  addBatches(
    "format-changed",
    "changed-file format",
    "scripts/tool-node-run.sh",
    ["node_modules/oxfmt/bin/oxfmt", "--check", "--threads=1", "--"],
    change.existing.filter(formattable),
  );
  for (const file of change.existing.filter(
    (file) => file.endsWith(".sh") || file.startsWith("setup/hooks/"),
  )) {
    phases.push(phase(`shell-${file}`, "changed shell syntax", "bash", ["-n", file]));
  }
  addBatches(
    "patterns-changed",
    "changed source policy",
    "node",
    ["scripts/check-patterns.js"],
    source,
  );
  addBatches(
    "sensors-changed",
    "changed-file lint",
    "nub",
    [
      "run",
      "lint:sensors",
      "--allow",
      "no-await-in-loop",
      "--deny-warnings",
      "--no-error-on-unmatched-pattern",
      "--",
    ],
    source,
  );
  for (const [checks, severity] of [
    ["duplicates", "warning"],
    ["async-risk", "error"],
  ]) {
    if (source.length)
      phases.push(
        script(
          `analyze-${checks}`,
          `changed-file ${checks}`,
          "analyze",
          "--diff",
          "--ref",
          change.base,
          "--checks",
          checks,
          "--fail-on",
          severity,
        ),
      );
  }
  if (!checksOnly) {
    // Vitest owns transitive import analysis. Component suites additionally cover CLI,
    // generated bundle, and filesystem inputs that its static import graph cannot see.
    const owners = new Set(change.files.map(owner).filter(Boolean));
    const suites = [...owners].flatMap((root) =>
      globSync([`${root}/__tests__/**/*.test.ts`, `${root}/__tests__/**/*.test.mjs`], { cwd }),
    );
    const inputs = [...new Set([...change.files.filter(codeFile), ...suites])].sort();
    if (inputs.length)
      phases.push(
        script(
          "related-tests",
          "affected component and import-related tests",
          "test",
          "related",
          "--passWithNoTests",
          ...inputs.map((file) => `./${file}`),
        ),
      );
    if (owners.has("setup")) phases.push(script("setup-tests", "setup tests", "test:setup"));
  }
  return phases;
}
