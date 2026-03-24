import { describe, it, expect } from "bun:test";
import {
	detectMergedBranch,
	isGitPull,
	parseHandoffBranch,
	parseMergedBranches,
} from "../handoff-cleanup";

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
		expect(detectMergedBranch("git -C /some/repo merge feat/x", mergeOutput)).toBe("feat/x");
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

// ─── isGitPull ───────────────────────────────────────────────────────────────

describe("isGitPull", () => {
	it("matches plain git pull", () => {
		expect(isGitPull("git pull")).toBe(true);
	});

	it("matches git pull origin main", () => {
		expect(isGitPull("git pull origin main")).toBe(true);
	});

	it("matches git pull --rebase", () => {
		expect(isGitPull("git pull --rebase")).toBe(true);
	});

	it("matches git -C /path pull", () => {
		expect(isGitPull("git -C /some/repo pull")).toBe(true);
	});

	it("does not match git push", () => {
		expect(isGitPull("git push origin feat/foo")).toBe(false);
	});

	it("does not match unrelated commands", () => {
		expect(isGitPull("git merge feat/foo")).toBe(false);
		expect(isGitPull("git status")).toBe(false);
		expect(isGitPull("npm install")).toBe(false);
	});
});

// ─── parseMergedBranches ─────────────────────────────────────────────────────

describe("parseMergedBranches", () => {
	it("parses branches from typical git branch --merged output", () => {
		const output = "  feat/done\n* main\n  fix/also-done\n";
		const result = parseMergedBranches(output);
		expect(result.has("feat/done")).toBe(true);
		expect(result.has("main")).toBe(true);
		expect(result.has("fix/also-done")).toBe(true);
		expect(result.size).toBe(3);
	});

	it("handles single branch (the current one marked with *)", () => {
		const output = "* main\n";
		const result = parseMergedBranches(output);
		expect(result.has("main")).toBe(true);
		expect(result.size).toBe(1);
	});

	it("returns empty set for empty output", () => {
		expect(parseMergedBranches("").size).toBe(0);
		expect(parseMergedBranches("\n\n").size).toBe(0);
	});

	it("ignores blank lines", () => {
		const output = "\n  feat/done\n\n  fix/other\n\n";
		const result = parseMergedBranches(output);
		expect(result.size).toBe(2);
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
