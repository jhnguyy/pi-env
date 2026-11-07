import { globSync, readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";

const script = (name, ...args) => ({ label: name, command: "nub", args: ["run", name, ...args] });
const codeFile = (file) => /\.[cm]?[jt]sx?$/.test(file);
const formattable = (file) => /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|md|css|html)$/.test(file);
function owner(file) {
  if (file.startsWith("extensions/_shared/")) return undefined;
  return /^(extensions\/[^/]+|src\/[^/]+|scripts|setup)\//.exec(file)?.[1];
}

function lintIgnorePatterns(cwd) {
  try {
    return (
      JSON.parse(readFileSync(join(cwd, ".oxlintrc-sensors.json"), "utf8")).ignorePatterns ?? []
    );
  } catch {
    return [];
  }
}

export function unqualifiedGlobalInputs(files) {
  return files.filter(
    (file) =>
      (!file.includes("/") && !/\.(?:md|txt)$/.test(file)) ||
      /^(?:\.github|nix|patches|tools)\//.test(file) ||
      (file.startsWith("extensions/_shared/") && !codeFile(file)),
  );
}

export function changedVerificationPlan(change, { checksOnly = false, cwd = process.cwd() } = {}) {
  const steps = [];
  const select = (name, args, files) => {
    for (let offset = 0; offset < files.length; offset += 128) {
      steps.push(script(name, ...args, ...files.slice(offset, offset + 128)));
    }
  };
  const source = change.edited.filter(codeFile);
  const renames = (change.renames ?? []).filter(({ to }) => codeFile(to));
  // Pattern and lint scopes depend on the path, so a rename can move unchanged content into them.
  // Content already linted at its old path keeps its findings; anything newly lintable is checked.
  const lintIgnored = lintIgnorePatterns(cwd);
  const linted = (file) =>
    codeFile(file) && !lintIgnored.some((pattern) => matchesGlob(file, pattern));
  const patternSource = [...source, ...renames.map(({ to }) => to)];
  const lintSource = [
    ...source,
    ...renames.filter(({ from, to }) => linted(to) && !linted(from)).map(({ to }) => to),
  ];
  select("format:files", ["--check", "--"], change.edited.filter(formattable));
  for (const file of change.edited.filter(
    (file) => file.endsWith(".sh") || file.startsWith("setup/hooks/"),
  )) {
    steps.push({ label: "shell syntax", command: "bash", args: ["-n", file] });
  }
  select("check:patterns", [], patternSource);
  select("lint:changed", ["--"], lintSource);
  if (patternSource.length) {
    steps.push(script("check:duplicates:changed", "--ref", change.base));
    steps.push(script("check:async-risk:changed", "--ref", change.base));
  }
  if (!checksOnly) {
    // Vitest supplies reverse import analysis for source changes. Component suites
    // cover non-source inputs, but this heuristic cannot qualify every dynamic dependency.
    const owners = new Set(
      change.files
        .filter((file) => !codeFile(file))
        .map(owner)
        .filter(Boolean),
    );
    const suites = [...owners].flatMap((root) =>
      globSync([`${root}/__tests__/**/*.test.ts`, `${root}/__tests__/**/*.test.mjs`], { cwd }),
    );
    const inputs = [...new Set([...change.files.filter(codeFile), ...suites])].sort();
    if (inputs.length)
      steps.push(
        script(
          "test:unit",
          "related",
          "--maxWorkers=1",
          "--no-file-parallelism",
          "--bail=1",
          "--passWithNoTests",
          ...inputs.map((file) => `./${file}`),
        ),
      );
  }
  return steps;
}
