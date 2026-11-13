import { globSync } from "node:fs";

const script = (name, ...args) => ({ label: name, command: "nub", args: ["run", name, ...args] });
const codeFile = (file) => /\.[cm]?[jt]sx?$/.test(file);
const formattable = (file) => /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|md|css|html)$/.test(file);
function owner(file) {
  if (file.startsWith("extensions/_shared/")) return undefined;
  return /^(extensions\/[^/]+|src\/[^/]+|scripts|setup)\//.exec(file)?.[1];
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
  // Renames change path-based policy; each checker decides applicability at the destination.
  const candidates = [...source, ...renames.map(({ to }) => to)];
  select("format:files", ["--check", "--"], change.edited.filter(formattable));
  for (const file of change.edited.filter(
    (file) => file.endsWith(".sh") || file.startsWith("setup/hooks/"),
  )) {
    steps.push({ label: "shell syntax", command: "bash", args: ["-n", file] });
  }
  select("check:patterns", [], candidates);
  select("lint:changed", ["--"], candidates);
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
          "--bail=1",
          "--passWithNoTests",
          ...inputs.map((file) => `./${file}`),
        ),
      );
  }
  return steps;
}
