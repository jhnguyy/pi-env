import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { Either } from "effect";
import type { PiUpdatePrep } from "./contract";
import { PI_PACKAGE_PREFIX } from "./contract";
import { PiUpdateError, PiUpdatePhase } from "./errors";

export function extractChangelogSection(changelogText: string, version: string): string {
  const lines = changelogText.split(/\r?\n/);
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex((line) => new RegExp(`^## \\[?${escapedVersion}\\]?`).test(line));
  if (start < 0) return "";
  const rest = lines.slice(start);
  const next = rest.findIndex((line, index) => index > 0 && line.startsWith("## "));
  return `${(next < 0 ? rest : rest.slice(0, next)).join("\n").trim()}\n`;
}

export function isPiPackageName(name: string): boolean {
  return name.startsWith(PI_PACKAGE_PREFIX);
}

export function packageNamesEither(packageJsonPath: string, targetPackage: (name: string) => boolean): Either.Either<string[], PiUpdateError> {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, Record<string, string> | undefined>;
    const names = [];
    for (const section of ["dependencies", "devDependencies"] as const) {
      for (const name of Object.keys(pkg[section] ?? {})) {
        if (targetPackage(name)) names.push(name);
      }
    }
    return names.length === 0
      ? Either.left(new PiUpdateError({ phase: PiUpdatePhase.PackageDiscovery, detail: "no matching packages found" }))
      : Either.right(names);
  } catch (cause) {
    return Either.left(new PiUpdateError({ phase: PiUpdatePhase.PackageDiscovery, detail: `failed to read ${packageJsonPath}`, cause }));
  }
}

export function packageNames(packageJsonPath: string, targetPackage: (name: string) => boolean): string[] {
  const result = packageNamesEither(packageJsonPath, targetPackage);
  if (Either.isLeft(result)) throw result.left;
  return result.right;
}

export function packageManagerName(packageJsonPath: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { packageManager?: unknown };
    return typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  } catch {
    return undefined;
  }
}

export function installCommandPrefix(packageManager?: string): string {
  return packageManager === "nub" ? "nub install -W --save-dev --save-exact" : "npm install --save-dev --save-exact";
}

export function writeInstallCommand(path: string, packageNames: string[], version: string, packageManager?: string): void {
  const lines = ["#!/usr/bin/env bash", "set -euo pipefail", `${installCommandPrefix(packageManager)} \\`];
  packageNames.forEach((name, index) => {
    lines.push(`  ${name}@${version}${index === packageNames.length - 1 ? "" : " \\"}`);
  });
  writeFileSync(path, `${lines.join("\n")}\n`);
  chmodSync(path, 0o755);
}

export function writeReport(path: string, prep: PiUpdatePrep): void {
  writeFileSync(
    path,
    `# pi ${prep.version} update prep\n\n` +
      `Worktree: ${prep.worktree}\n` +
      `Branch: ${prep.branch}\n` +
      `Changelog section: ${prep.changelog}\n` +
      `Install command: ${prep.installCommand}\n\n` +
      `## Decision prompt\n\n` +
      `Review the changelog section against pi-env before applying. Check especially:\n\n` +
      `- package exports and imports used by extensions\n` +
      `- extension lifecycle/API changes\n` +
      `- settings, package loading, project trust, and resource discovery behavior\n` +
      `- CLI flags used by setup scripts, skills, and extension-spawned pi commands\n` +
      `- user-facing behavior that should be reported back\n\n` +
      `If no pi-env adjustments are required, run the install command in the worktree, run nub run verify, then commit, push, and file a PR.\n` +
      `If breaking or ambiguous changes exist, propose the pi-env adjustment plan before updating dependencies.\n`,
  );
}

export function buildDecisionPrompt(prep: PiUpdatePrep): string {
  return [
    `Continue the pi ${prep.version} update using the prepared artifacts.`,
    ``,
    `Prepared branch/worktree: ${prep.branch} at ${prep.worktree}`,
    `Report: ${prep.report}`,
    `Changelog section: ${prep.changelog}`,
    `Install command: ${prep.installCommand}`,
    ``,
    `Decision task: read the report and changelog section, compare the release against pi-env, and decide what is needed for this update. Focus on package exports/imports, extension lifecycle/API changes, settings/package/trust behavior, CLI flags used by setup/scripts/extensions, and user-facing changes to report back.`,
    ``,
    `If no pi-env adjustments are required, run the install command in the worktree, run nub run verify, commit as "chore: update pi to ${prep.version}", push, and file a PR. If changes are breaking or ambiguous, propose the adjustment plan before updating dependencies.`,
  ].join("\n");
}
