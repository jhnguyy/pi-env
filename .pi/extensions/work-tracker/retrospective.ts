import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import type { Retrospective } from "./types";

export class RetrospectiveStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  write(retro: Retrospective): string {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    // Filename: YYYYMMDD-HHMMSS-<sessionId>.json
    const ts = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace("T", "-")
      .slice(0, 15); // 20260305-072300
    const filename = `${ts}-${retro.sessionId}.json`;
    const filepath = `${this.dir}/${filename}`;
    writeFileSync(filepath, JSON.stringify(retro, null, 2) + "\n", "utf8");
    return filepath;
  }

  /**
   * Read all retrospectives from disk, sorted newest-first (by filename timestamp).
   * Returns an empty array if the directory does not exist.
   */
  readAll(): Retrospective[] {
    if (!existsSync(this.dir)) return [];
    let files: string[];
    try {
      files = readdirSync(this.dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .reverse(); // newest filename = latest timestamp
    } catch {
      return [];
    }
    const retros: Retrospective[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(`${this.dir}/${file}`, "utf8");
        retros.push(JSON.parse(raw) as Retrospective);
      } catch {
        // Skip malformed files
      }
    }
    return retros;
  }
}

// ─── Pure formatting helpers (exported for testing) ───────────────────────────

const OUTCOME_ICON: Record<Retrospective["outcome"], string> = {
  success: "✅",
  partial: "🔶",
  abandoned: "❌",
};

/**
 * Formats a list of retrospectives for `/retro` display.
 * Accepts up to `limit` entries (default 10), already sorted newest-first.
 */
export function formatRetroList(
  retros: Retrospective[],
  limit = 10
): string {
  if (retros.length === 0) return "(no retrospectives yet)";

  const shown = retros.slice(0, limit);
  const header = `Retrospectives (${shown.length} of ${retros.length} sessions)`;
  const divider = "─".repeat(54);
  const rows = shown.map((r) => {
    const icon = OUTCOME_ICON[r.outcome] ?? "❓";
    const date = new Date(r.completedAt).toLocaleString("sv-SE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).replace("T", " "); // ensure no T separator from sv-SE
    const branchRepo =
      r.branch && r.repo
        ? `${r.branch} (${r.repo})`
        : r.branch ?? "(no branch)";
    const fileCount = r.filesChanged.length;
    const fileLabel = fileCount === 1 ? "1 file " : `${fileCount} files`;
    return `${icon} ${date}  ${branchRepo.padEnd(30)}  ${String(r.durationMinutes + "m").padStart(4)}  ${fileLabel}`;
  });

  return [header, divider, ...rows].join("\n");
}

/**
 * Formats a single retrospective as a markdown vault entry.
 */
export function formatVaultEntry(retro: Retrospective): string {
  const icon = OUTCOME_ICON[retro.outcome] ?? "❓";
  const date = new Date(retro.completedAt).toLocaleString("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const branchLine =
    retro.branch && retro.repo
      ? `${retro.branch} (${retro.repo})`
      : retro.branch ?? "(no branch)";
  const fileList =
    retro.filesChanged.length > 0
      ? retro.filesChanged.map((f) => `  - ${f}`).join("\n")
      : "  (none)";

  return [
    `## ${icon} ${retro.task}`,
    ``,
    `- **Date:** ${date}`,
    `- **Outcome:** ${retro.outcome}`,
    `- **Duration:** ${retro.durationMinutes}m`,
    `- **Branch:** ${branchLine}`,
    `- **Files changed:**`,
    fileList,
    retro.notes ? `\n**Notes:** ${retro.notes}` : "",
  ]
    .filter((line) => line !== undefined)
    .join("\n")
    .trimEnd();
}
