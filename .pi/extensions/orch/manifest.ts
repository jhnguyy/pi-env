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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { OrchManifest, RunReceipt } from "./types";

export const RECEIPT_DIR = "/tmp/orch-runs";

// ─── Manifest ─────────────────────────────────────────────────

export function writeManifest(orchDir: string, manifest: OrchManifest): void {
  writeFileSync(`${orchDir}/.manifest.json`, JSON.stringify(manifest, null, 2));
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
