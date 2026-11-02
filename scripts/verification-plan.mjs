import { globSync } from "node:fs";

const script = (name, ...args) => ({ label: name, command: "nub", args: ["run", name, ...args] });
const codeFile = (file) => /\.[cm]?[jt]sx?$/.test(file);
const formattable = (file) => /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|md|css|html)$/.test(file);
function owner(file) {
  if (file.startsWith(".pi/extensions/_shared/")) return ".pi/extensions";
  return /^(\.pi\/extensions\/[^/]+|src\/[^/]+|scripts|setup)\//.exec(file)?.[1];
}

export function changedVerificationPlan(change, { checksOnly = false, cwd = process.cwd() } = {}) {
  const steps = [];
  const select = (name, args, files) => {
    for (let offset = 0; offset < files.length; offset += 128) {
      steps.push(script(name, ...args, ...files.slice(offset, offset + 128)));
    }
  };
  const source = change.existing.filter(codeFile);
  select("format:files", ["--check", "--"], change.existing.filter(formattable));
  for (const file of change.existing.filter(
    (file) => file.endsWith(".sh") || file.startsWith("setup/hooks/"),
  )) {
    steps.push({ label: "shell syntax", command: "bash", args: ["-n", file] });
  }
  select("check:patterns", [], source);
  select("lint:changed", ["--"], source);
  if (source.length) {
    steps.push(script("check:duplicates:changed", "--ref", change.base));
    steps.push(script("check:async-risk:changed", "--ref", change.base));
  }
  if (!checksOnly) {
    // Vitest supplies reverse import analysis. Component suites cover additional
    // CLI/filesystem inputs, but this heuristic cannot qualify every dynamic dependency.
    const owners = new Set(change.files.map(owner).filter(Boolean));
    const suites = [...owners].flatMap((root) =>
      globSync([`${root}/__tests__/**/*.test.ts`, `${root}/__tests__/**/*.test.mjs`], { cwd }),
    );
    const inputs = [...new Set([...change.files.filter(codeFile), ...suites])].sort();
    if (inputs.length)
      steps.push(
        script("test:unit", "related", "--passWithNoTests", ...inputs.map((file) => `./${file}`)),
      );
  }
  return steps;
}
