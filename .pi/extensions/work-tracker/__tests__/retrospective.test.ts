import { describe, it, expect } from "bun:test";
import { formatRetroList, formatVaultEntry } from "../retrospective";
import type { Retrospective } from "../types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRetro(overrides: Partial<Retrospective> = {}): Retrospective {
  return {
    sessionId: "abc123",
    task: "build the feature",
    branch: "feat/build",
    repo: "pi-env",
    outcome: "success",
    startedAt: "2026-03-05T07:00:00Z",
    completedAt: "2026-03-05T07:42:00Z",
    durationMinutes: 42,
    filesChanged: ["src/index.ts", "src/types.ts", "README.md"],
    notes: "",
    ...overrides,
  };
}

// ─── formatRetroList ──────────────────────────────────────────────────────────

describe("formatRetroList", () => {
  it("returns placeholder when no retrospectives", () => {
    const result = formatRetroList([]);
    expect(result).toBe("(no retrospectives yet)");
  });

  it("includes header with session count", () => {
    const retros = [makeRetro()];
    const result = formatRetroList(retros);
    expect(result).toContain("Retrospectives");
    expect(result).toContain("1");
  });

  it("shows ✅ icon for success outcome", () => {
    const result = formatRetroList([makeRetro({ outcome: "success" })]);
    expect(result).toContain("✅");
  });

  it("shows 🔶 icon for partial outcome", () => {
    const result = formatRetroList([makeRetro({ outcome: "partial" })]);
    expect(result).toContain("🔶");
  });

  it("shows ❌ icon for abandoned outcome", () => {
    const result = formatRetroList([makeRetro({ outcome: "abandoned" })]);
    expect(result).toContain("❌");
  });

  it("includes branch and repo in output", () => {
    const result = formatRetroList([makeRetro({ branch: "feat/build", repo: "pi-env" })]);
    expect(result).toContain("feat/build");
    expect(result).toContain("pi-env");
  });

  it("shows '(no branch)' when branch is null", () => {
    const result = formatRetroList([makeRetro({ branch: null, repo: null })]);
    expect(result).toContain("(no branch)");
  });

  it("displays duration in minutes", () => {
    const result = formatRetroList([makeRetro({ durationMinutes: 42 })]);
    expect(result).toContain("42m");
  });

  it("displays file count", () => {
    const result = formatRetroList([makeRetro({ filesChanged: ["a.ts", "b.ts"] })]);
    expect(result).toContain("2 files");
  });

  it("shows '1 file' for single file (not '1 files')", () => {
    const result = formatRetroList([makeRetro({ filesChanged: ["a.ts"] })]);
    expect(result).toContain("1 file");
    expect(result).not.toContain("1 files");
  });

  it("caps output at 10 entries by default", () => {
    const retros = Array.from({ length: 15 }, (_, i) =>
      makeRetro({ sessionId: `s${i}`, completedAt: `2026-03-05T0${String(i).padStart(1, "0")}:00:00Z` })
    );
    const result = formatRetroList(retros);
    // Count the icon lines — there should be exactly 10
    const iconLines = result.split("\n").filter(
      (l) => l.startsWith("✅") || l.startsWith("🔶") || l.startsWith("❌")
    );
    expect(iconLines).toHaveLength(10);
  });

  it("respects custom limit", () => {
    const retros = Array.from({ length: 5 }, (_, i) =>
      makeRetro({ sessionId: `s${i}` })
    );
    const result = formatRetroList(retros, 3);
    const iconLines = result.split("\n").filter(
      (l) => l.startsWith("✅") || l.startsWith("🔶") || l.startsWith("❌")
    );
    expect(iconLines).toHaveLength(3);
  });

  it("multiple entries appear in provided order (newest-first assumed)", () => {
    // Use distinct branches so we can locate them in the rendered output
    const older = makeRetro({ sessionId: "old", branch: "feat/older-branch", completedAt: "2026-03-04T10:00:00Z" });
    const newer = makeRetro({ sessionId: "new", branch: "feat/newer-branch", completedAt: "2026-03-05T10:00:00Z" });
    // Pass newest-first (as readAll() would deliver)
    const result = formatRetroList([newer, older]);
    const newerIdx = result.indexOf("feat/newer-branch");
    const olderIdx = result.indexOf("feat/older-branch");
    // newer entry should appear before older entry in the formatted output
    expect(newerIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeGreaterThanOrEqual(0);
    expect(newerIdx).toBeLessThan(olderIdx);
  });
});

// ─── formatVaultEntry ─────────────────────────────────────────────────────────

describe("formatVaultEntry", () => {
  it("includes the task as a heading", () => {
    const result = formatVaultEntry(makeRetro({ task: "build the feature" }));
    expect(result).toContain("## ");
    expect(result).toContain("build the feature");
  });

  it("includes outcome", () => {
    const result = formatVaultEntry(makeRetro({ outcome: "success" }));
    expect(result).toContain("success");
  });

  it("includes duration in minutes", () => {
    const result = formatVaultEntry(makeRetro({ durationMinutes: 31 }));
    expect(result).toContain("31m");
  });

  it("includes branch and repo", () => {
    const result = formatVaultEntry(makeRetro({ branch: "feat/x", repo: "nix-config" }));
    expect(result).toContain("feat/x");
    expect(result).toContain("nix-config");
  });

  it("shows '(no branch)' when branch is null", () => {
    const result = formatVaultEntry(makeRetro({ branch: null, repo: null }));
    expect(result).toContain("(no branch)");
  });

  it("lists changed files", () => {
    const result = formatVaultEntry(makeRetro({ filesChanged: ["src/a.ts", "src/b.ts"] }));
    expect(result).toContain("src/a.ts");
    expect(result).toContain("src/b.ts");
  });

  it("shows (none) when no files changed", () => {
    const result = formatVaultEntry(makeRetro({ filesChanged: [] }));
    expect(result).toContain("(none)");
  });

  it("includes notes when present", () => {
    const result = formatVaultEntry(makeRetro({ notes: "tricky edge case with timezones" }));
    expect(result).toContain("tricky edge case with timezones");
  });

  it("outcome icon: success → ✅", () => {
    const result = formatVaultEntry(makeRetro({ outcome: "success" }));
    expect(result).toContain("✅");
  });

  it("outcome icon: partial → 🔶", () => {
    const result = formatVaultEntry(makeRetro({ outcome: "partial" }));
    expect(result).toContain("🔶");
  });

  it("outcome icon: abandoned → ❌", () => {
    const result = formatVaultEntry(makeRetro({ outcome: "abandoned" }));
    expect(result).toContain("❌");
  });
});
