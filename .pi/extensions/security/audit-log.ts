/**
 * AuditLog — append-only JSONL log of all permission decisions.
 *
 * Stored at ~/.pi/permissions-audit.jsonl.
 * Each line is a JSON object with timestamp, tool, decision, etc.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import type { AuditEntry } from "./types";

export class AuditLog {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.ensureDir();
  }

  /** Append an audit entry */
  log(entry: AuditEntry): void {
    try {
      const line = JSON.stringify(entry) + "\n";
      appendFileSync(this.filePath, line, "utf-8");
    } catch (err) {
      console.warn(`[permissions] Failed to write audit log: ${err}`);
    }
  }

  /** Read the last N entries */
  getRecent(n: number = 20): AuditEntry[] {
    try {
      if (!existsSync(this.filePath)) return [];

      const content = readFileSync(this.filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      return lines
        .slice(-n)
        .map((line) => {
          try {
            return JSON.parse(line) as AuditEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is AuditEntry => e !== null);
    } catch {
      return [];
    }
  }

  /** Ensure the directory exists */
  private ensureDir(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
