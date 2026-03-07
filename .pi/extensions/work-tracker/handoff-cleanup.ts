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
 * Scans the handoffs directory for files whose `branch` frontmatter field
 * matches the given branch name, deletes them, and returns the deleted filenames.
 */
export function cleanupHandoffs(branch: string): string[] {
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
			if (parseHandoffBranch(content) === branch) {
				unlinkSync(filePath);
				deleted.push(file);
			}
		} catch {
			// Skip files that can't be read or deleted
		}
	}
	return deleted;
}
