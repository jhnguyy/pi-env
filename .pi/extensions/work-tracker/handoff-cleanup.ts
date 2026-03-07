import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HANDOFFS_DIR = join(homedir(), ".pi", "agent", "handoffs");

/**
 * Detects whether a bash command + its output indicate a successful git merge.
 * Returns the name of the branch that was merged in, or null.
 *
 * Handles:
 *   git merge feat/foo
 *   git merge --no-ff feat/foo
 *   git -C /path merge --squash feat/foo
 */
export function detectMergedBranch(command: string, output: string): string | null {
	if (!/\bgit\b.*\bmerge\b/.test(command)) return null;

	// Git outputs these on successful merge (not on conflict or already-up-to-date)
	if (!/Merge made by|Fast-forward/.test(output)) return null;

	// Extract the branch name: everything after `merge` and its flags
	const m = command.match(/\bmerge\b\s+(?:--\S+\s+)*([^\s-]\S*)/);
	return m ? m[1] : null;
}

/**
 * Parses the `branch` field from a handoff file's YAML frontmatter.
 * Returns null if no branch field exists.
 */
export function parseHandoffBranch(content: string): string | null {
	const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!fmMatch) return null;
	const branchLine = fmMatch[1].split(/\r?\n/).find((l) => /^branch:\s*/.test(l));
	if (!branchLine) return null;
	return branchLine.replace(/^branch:\s*/, "").trim() || null;
}

/**
 * Returns true if the bash command is any form of git pull.
 */
export function isGitPull(command: string): boolean {
	return /\bgit\b.*\bpull\b/.test(command);
}

/**
 * Parses the output of `git branch --merged HEAD` into a Set of branch names.
 * Strips the current-branch `*` prefix and surrounding whitespace.
 */
export function parseMergedBranches(output: string): Set<string> {
	const branches = new Set<string>();
	for (const line of output.split("\n")) {
		const branch = line.replace(/^\*?\s+/, "").trim();
		if (branch) branches.add(branch);
	}
	return branches;
}

/**
 * Scans the handoffs directory for files whose `branch` frontmatter field
 * appears in the given branch set, deletes them, and returns the deleted filenames.
 *
 * Accepts a single branch name or a Set for bulk cleanup (e.g. after git pull).
 */
export function cleanupHandoffs(branches: string | Set<string>): string[] {
	const branchSet =
		typeof branches === "string" ? new Set([branches]) : branches;
	const deleted: string[] = [];
	let files: string[];
	try {
		files = readdirSync(HANDOFFS_DIR).filter(
			(f) => f.endsWith(".md") && f !== "README.md",
		);
	} catch {
		return deleted; // Directory doesn't exist or unreadable — nothing to clean
	}

	for (const file of files) {
		const filePath = join(HANDOFFS_DIR, file);
		try {
			const content = readFileSync(filePath, "utf8");
			const handoffBranch = parseHandoffBranch(content);
			if (handoffBranch && branchSet.has(handoffBranch)) {
				unlinkSync(filePath);
				deleted.push(file);
			}
		} catch {
			// Skip files that can't be read or deleted
		}
	}
	return deleted;
}
