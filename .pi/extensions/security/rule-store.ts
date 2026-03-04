/**
 * RuleStore — manages rule persistence for both global and session scopes.
 *
 * Global rules:  ~/.pi/permissions.json (shared across all pi instances)
 * Session rules: in-memory, populated from session entries on startup
 *
 * File reads use mtime-based caching so multiple pi instances see
 * each other's changes without polling overhead.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { Rule } from "./rule";
import type { PermissionsConfig, RuleDefinition, SessionMode } from "./types";

export class RuleStore {
  private filePath: string;
  private globalRules: RuleDefinition[] = [];
  private sessionRules: RuleDefinition[] = [];
  private sessionMode: SessionMode = "default";

  /** Cached file stats for change detection */
  private lastMtime: number = 0;
  private lastSize: number = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.ensureFile();
    this.loadFromDisk();
  }

  // ─── Global Rules ───────────────────────────────────────────────

  /** Reload global rules from disk (called on session start) */
  reload(): void {
    this.loadFromDisk();
  }

  /** Add a global rule and save to disk */
  addRule(rule: RuleDefinition): void {
    const errors = Rule.validate(rule);
    if (errors.length > 0) {
      throw new Error(`Invalid rule: ${errors.join("; ")}`);
    }
    this.refreshIfChanged();
    this.globalRules.push(rule);
    this.saveToDisk();
  }

  /** Remove a global rule by id. Returns true if found. */
  removeRule(id: string): boolean {
    this.refreshIfChanged();
    const before = this.globalRules.length;
    this.globalRules = this.globalRules.filter((r) => r.id !== id);
    if (this.globalRules.length < before) {
      this.saveToDisk();
      return true;
    }
    return false;
  }

  /** Get all global rules (refreshes from disk if file changed) */
  getGlobalRules(): RuleDefinition[] {
    this.refreshIfChanged();
    return [...this.globalRules];
  }

  // ─── Session Rules ──────────────────────────────────────────────

  /** Replace all session rules (called on session reconstruct) */
  setSessionRules(rules: RuleDefinition[]): void {
    this.sessionRules = rules.filter((r) => {
      const errors = Rule.validate(r);
      if (errors.length > 0) {
        console.warn(`[permissions] Skipping invalid session rule "${r.id}": ${errors.join("; ")}`);
        return false;
      }
      return true;
    });
  }

  // ─── Session Mode ───────────────────────────────────────────────

  getSessionMode(): SessionMode {
    return this.sessionMode;
  }

  setSessionMode(mode: SessionMode): void {
    this.sessionMode = mode;
  }

  /** Add a session rule (in-memory only; caller handles appendEntry) */
  addSessionRule(rule: RuleDefinition): void {
    const errors = Rule.validate(rule);
    if (errors.length > 0) {
      throw new Error(`Invalid rule: ${errors.join("; ")}`);
    }
    this.sessionRules.push(rule);
  }

  // ─── Combined ───────────────────────────────────────────────────

  /**
   * Get all rules, session rules first (higher priority).
   * Session rules override global rules for the same pattern.
   */
  getAllRules(): RuleDefinition[] {
    this.refreshIfChanged();
    return [...this.sessionRules, ...this.globalRules];
  }

  // ─── File I/O ───────────────────────────────────────────────────

  /** Ensure the permissions file exists with valid JSON */
  private ensureFile(): void {
    if (!existsSync(this.filePath)) {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.filePath, "{}", "utf-8");
    }
  }

  /** Load rules from disk */
  private loadFromDisk(): void {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      const config = this.normalize(parsed);

      // Validate each rule, skip invalid ones
      this.globalRules = config.rules.filter((r) => {
        const errors = Rule.validate(r);
        if (errors.length > 0) {
          console.warn(`[permissions] Skipping invalid rule "${r.id}": ${errors.join("; ")}`);
          return false;
        }
        return true;
      });

      const stat = this.getFileStat();
      this.lastMtime = stat.mtime;
      this.lastSize = stat.size;
    } catch (err) {
      console.warn(`[permissions] Failed to load ${this.filePath}: ${err}`);
      this.globalRules = [];
    }
  }

  /** Refresh from disk only if file has been modified (mtime or size) */
  private refreshIfChanged(): void {
    const stat = this.getFileStat();
    if (stat.mtime !== this.lastMtime || stat.size !== this.lastSize) {
      this.loadFromDisk();
    }
  }

  /** Save global rules to disk (atomic write via temp file) */
  private saveToDisk(): void {
    const config: PermissionsConfig = {
      version: 1,
      rules: this.globalRules,
    };
    const content = JSON.stringify(config, null, 2);
    const tmpPath = `${this.filePath}.tmp`;

    try {
      writeFileSync(tmpPath, content, "utf-8");
      renameSync(tmpPath, this.filePath);
      const stat = this.getFileStat();
      this.lastMtime = stat.mtime;
      this.lastSize = stat.size;
    } catch (err) {
      console.error(`[permissions] Failed to save ${this.filePath}: ${err}`);
    }
  }

  /** Get file stats for change detection */
  private getFileStat(): { mtime: number; size: number } {
    try {
      const s = statSync(this.filePath);
      return { mtime: s.mtimeMs, size: s.size };
    } catch {
      return { mtime: 0, size: 0 };
    }
  }

  /** Normalize raw JSON to PermissionsConfig */
  private normalize(raw: unknown): PermissionsConfig {
    if (raw && typeof raw === "object" && "rules" in raw && Array.isArray((raw as any).rules)) {
      return raw as PermissionsConfig;
    }
    return { version: 1, rules: [] };
  }
}
