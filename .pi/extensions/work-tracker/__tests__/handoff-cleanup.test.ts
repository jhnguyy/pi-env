import { describe, it, expect } from "bun:test";
import { detectMergedBranch, parseHandoffBranch } from "../handoff-cleanup";

// ─── detectMergedBranch ───────────────────────────────────────────────────────

describe("detectMergedBranch", () => {
	const mergeOutput = "Merge made by the 'ort' strategy.";
	const ffOutput = "Fast-forward\n some files changed";
	const conflictOutput = "CONFLICT (content): Merge conflict in foo.ts";
	const alreadyOutput = "Already up to date.";

	it("returns branch for plain git merge on success", () => {
		expect(detectMergedBranch("git merge feat/my-work", mergeOutput)).toBe("feat/my-work");
	});

	it("returns branch for git merge --no-ff", () => {
		expect(detectMergedBranch("git merge --no-ff feat/cleanup", mergeOutput)).toBe("feat/cleanup");
	});

	it("returns branch for git merge --squash", () => {
		expect(detectMergedBranch("git merge --squash fix/typo", mergeOutput)).toBe("fix/typo");
	});

	it("returns branch for fast-forward merge output", () => {
		expect(detectMergedBranch("git merge feat/docs", ffOutput)).toBe("feat/docs");
	});

	it("returns branch for git -C <path> merge", () => {
		expect(detectMergedBranch("git -C /mnt/tank/code/pi-env merge feat/x", mergeOutput)).toBe("feat/x");
	});

	it("returns null when output shows conflict (not successful)", () => {
		expect(detectMergedBranch("git merge feat/my-work", conflictOutput)).toBeNull();
	});

	it("returns null for already-up-to-date (no merge happened)", () => {
		expect(detectMergedBranch("git merge feat/my-work", alreadyOutput)).toBeNull();
	});

	it("returns null for non-merge commands", () => {
		expect(detectMergedBranch("git push origin feat/my-work", mergeOutput)).toBeNull();
		expect(detectMergedBranch("git status", mergeOutput)).toBeNull();
		expect(detectMergedBranch("echo merge made by me", mergeOutput)).toBeNull();
	});

	it("returns null when command has no branch after flags", () => {
		// git merge with no branch arg (shouldn't happen but guard it)
		expect(detectMergedBranch("git merge", mergeOutput)).toBeNull();
	});
});

// ─── parseHandoffBranch ───────────────────────────────────────────────────────

describe("parseHandoffBranch", () => {
	it("parses branch from standard frontmatter", () => {
		const content = `---
created: 2026-03-07
branch: feat/my-feature
status: ready-to-start
---

## Goal
`;
		expect(parseHandoffBranch(content)).toBe("feat/my-feature");
	});

	it("returns null when no branch field", () => {
		const content = `---
created: 2026-03-07
status: ready-to-start
---

## Goal
`;
		expect(parseHandoffBranch(content)).toBeNull();
	});

	it("returns null when no frontmatter at all", () => {
		expect(parseHandoffBranch("# Just a markdown file\n\nNo frontmatter here.")).toBeNull();
	});

	it("handles extra whitespace around branch value", () => {
		const content = `---\nbranch:   feat/spaced  \n---\n`;
		expect(parseHandoffBranch(content)).toBe("feat/spaced");
	});

	it("returns null when branch field is empty", () => {
		const content = `---\nbranch: \n---\n`;
		expect(parseHandoffBranch(content)).toBeNull();
	});
});
