/**
 * Manifest I/O for orch.
 *
 * Two artifacts:
 *   - ORCH_DIR/.manifest.json — live state, updated on every spawn.
 *     Deleted by orch cleanup. Used for status and recovery.
 *
 *   - /tmp/orch-runs/<ts>-<runId>.json — run receipt written at cleanup.
 *     Stable after the run ends. Used for retrospectives: query with
 *     `ls -lt /tmp/orch-runs/` to see recent runs.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, rmSync, unlinkSync, statSync } from "node:fs";
import type { OrchManifest, RunReceipt } from "./types";

export const RECEIPT_DIR = "/tmp/orch-runs";

// ─── Manifest ─────────────────────────────────────────────────

export function writeManifest(orchDir: string, manifest: OrchManifest): void {
  const target = `${orchDir}/.manifest.json`;
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  renameSync(tmp, target);
}

export function readManifest(orchDir: string): OrchManifest {
  const raw = readFileSync(`${orchDir}/.manifest.json`, "utf8");
  return JSON.parse(raw) as OrchManifest;
}

// ─── Run Receipt ──────────────────────────────────────────────

export function writeReceipt(receipt: RunReceipt): string {
  mkdirSync(RECEIPT_DIR, { recursive: true });
  const filename = `${receipt.endedAt}-${receipt.runId}.json`;
  const path = `${RECEIPT_DIR}/${filename}`;
  writeFileSync(path, JSON.stringify(receipt, null, 2));
  return path;
}

// ─── Receipt Pruning ──────────────────────────────────────────

/** Maximum number of receipts to keep. Oldest are deleted first. */
const MAX_RECEIPTS = 100;

/**
 * Prune old receipts, keeping only the most recent MAX_RECEIPTS.
 * Filenames sort chronologically (timestamp prefix). Best-effort: ignores errors.
 */
export function pruneReceipts(maxKeep: number = MAX_RECEIPTS): number {
  try {
    const files = readdirSync(RECEIPT_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort(); // ascending by timestamp prefix
    if (files.length <= maxKeep) return 0;
    const toDelete = files.slice(0, files.length - maxKeep);
    let deleted = 0;
    for (const file of toDelete) {
      try { unlinkSync(`${RECEIPT_DIR}/${file}`); deleted++; } catch {}
    }
    return deleted;
  } catch {
    return 0;
  }
}

// ─── Orphan Cleanup ───────────────────────────────────────────

/**
 * Remove orphaned /tmp/orch-* directories that are not the active orchDir.
 * These are left behind by crashed or improperly cleaned runs.
 * Best-effort: ignores errors. Skips receipt and shared dirs.
 */
export function cleanupOrphanedOrchDirs(activeOrchDir?: string): number {
  const SKIP = new Set(["orch-runs", "orch-briefs", "orch-results"]);
  try {
    const entries = readdirSync("/tmp")
      .filter((e) => e.startsWith("orch-") && !SKIP.has(e));
    let cleaned = 0;
    for (const entry of entries) {
      const fullPath = `/tmp/${entry}`;
      if (fullPath === activeOrchDir) continue;
      try {
        const stat = statSync(fullPath);
        if (!stat.isDirectory()) continue;
        // Only clean dirs older than 1 hour to avoid race with in-progress spawns
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs < 3_600_000) continue;
        rmSync(fullPath, { recursive: true, force: true });
        cleaned++;
      } catch {}
    }
    return cleaned;
  } catch {
    return 0;
  }
}
