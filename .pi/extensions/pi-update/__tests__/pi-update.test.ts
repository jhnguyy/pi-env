import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDecisionPrompt, extractChangelogSection, isPiPackageName, packageNames, parseArgs, writeInstallCommand, type PiUpdatePrep } from "../index";

describe("pi-update", () => {
  it("parses version and optional paths", () => {
    expect(parseArgs("0.80.0 --repo /repo --worktree-dir /tmp/wt")).toEqual({
      version: "0.80.0",
      repo: "/repo",
      worktreeDir: "/tmp/wt",
    });
  });

  it("defaults to latest", () => {
    expect(parseArgs("")).toEqual({ version: "latest" });
  });

  it("extracts only the requested changelog section", () => {
    const section = extractChangelogSection(`# Changelog\n\n## [0.80.0] - today\n\n- new\n\n## [0.79.0]\n\n- old\n`, "0.80.0");

    expect(section).toContain("## [0.80.0]");
    expect(section).toContain("- new");
    expect(section).not.toContain("0.79.0");
  });

  it("discovers pinned pi package names and writes the exact install command", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-update-test-"));
    const pkg = join(dir, "package.json");
    const command = join(dir, "install-command.sh");
    writeFileSync(pkg, JSON.stringify({ devDependencies: { "@earendil-works/pi-ai": "0.79.0", vitest: "^4" } }));

    const names = packageNames(pkg, isPiPackageName);
    writeInstallCommand(command, names, "0.80.0");

    expect(names).toEqual(["@earendil-works/pi-ai"]);
    expect(readFileSync(command, "utf8")).toContain("@earendil-works/pi-ai@0.80.0");
  });

  it("creates a concise handoff prompt from prepared artifacts", () => {
    const prep: PiUpdatePrep = {
      version: "0.80.0",
      branch: "chore/update-pi-0.80.0",
      worktree: "/tmp/pi-env-update",
      report: "/tmp/pi-env-update/.pi-update/0.80.0/report.md",
      changelog: "/tmp/pi-env-update/.pi-update/0.80.0/changelog-section.md",
      installCommand: "/tmp/pi-env-update/.pi-update/0.80.0/install-command.sh",
    };

    const prompt = buildDecisionPrompt(prep);

    expect(prompt).toContain("Continue the pi 0.80.0 update");
    expect(prompt).toContain("read the report and changelog section");
    expect(prompt).toContain("chore: update pi to 0.80.0");
  });
});
