/**
 * BusTransport — filesystem I/O boundary.
 *
 * All filesystem interaction lives here. Pure side-effect boundary.
 * BusTransport interface preserves v2 swap to WebSocket/IPC transport.
 * FsTransport is the v1 implementation: zero deps, zero processes, atomic writes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

import type { BusMessage, CursorRecord } from "./types";

// ─── Interface ────────────────────────────────────────────────

export interface BusTransport {
  /** Create session directory structure. Idempotent. */
  ensureSession(sessionId: string): void;

  /** Check if session directory exists. */
  sessionExists(sessionId: string): boolean;

  /** Atomically write a message to a channel. */
  publish(sessionId: string, channel: string, msg: BusMessage): void;

  /**
   * Read all messages from a channel newer than `since` (exclusive).
   * Returns messages sorted by timestamp ascending. Skips corrupt files.
   */
  readMessages(sessionId: string, channel: string, since: number): BusMessage[];

  /** Count messages in a channel newer than `since` (exclusive). */
  countMessages(sessionId: string, channel: string, since: number): number;

  /** List channel names that have at least one message file. */
  getChannels(sessionId: string): string[];

  /** Read cursor record for an agent. Returns {} if not found. */
  readCursor(sessionId: string, agentId: string): CursorRecord;

  /**
   * Merge updates into agent cursor file. Per-channel max wins (never rewinds).
   * Atomic: write-to-temp + renameSync.
   */
  updateCursor(sessionId: string, agentId: string, updates: CursorRecord): void;
}

// ─── Filesystem Implementation ───────────────────────────────

export class FsTransport implements BusTransport {
  private readonly busRoot = "/tmp";

  private sessionDir(sessionId: string): string {
    return path.join(this.busRoot, `pi-bus-${sessionId}`);
  }

  private channelDir(sessionId: string, channel: string): string {
    return path.join(this.sessionDir(sessionId), "channels", channel);
  }

  private cursorFile(sessionId: string, agentId: string): string {
    // Sanitize agentId for filename safety (replace non-alphanumeric/hyphen with -)
    const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, "-");
    return path.join(this.sessionDir(sessionId), "cursors", `${safe}.json`);
  }

  // ─── ensureSession ───────────────────────────────────────────

  ensureSession(sessionId: string): void {
    fs.mkdirSync(path.join(this.sessionDir(sessionId), "channels"), { recursive: true });
    fs.mkdirSync(path.join(this.sessionDir(sessionId), "cursors"), { recursive: true });
  }

  // ─── sessionExists ───────────────────────────────────────────

  sessionExists(sessionId: string): boolean {
    try {
      fs.accessSync(this.sessionDir(sessionId));
      return true;
    } catch {
      return false;
    }
  }

  // ─── publish ─────────────────────────────────────────────────

  publish(sessionId: string, channel: string, msg: BusMessage): void {
    const dir = this.channelDir(sessionId, channel);
    fs.mkdirSync(dir, { recursive: true });

    // Filename: <timestamp>-<sender>-<random4hex>.json
    // Random suffix prevents collision on same-ms publishes from same sender.
    const safe = msg.sender.replace(/[^a-zA-Z0-9_-]/g, "-");
    const rand = randomBytes(2).toString("hex");
    const filename = `${msg.timestamp}-${safe}-${rand}.json`;
    const filePath = path.join(dir, filename);
    const tmpPath = filePath + ".tmp";

    fs.writeFileSync(tmpPath, JSON.stringify(msg), "utf-8");
    fs.renameSync(tmpPath, filePath);
  }

  // ─── readMessages ────────────────────────────────────────────

  readMessages(sessionId: string, channel: string, since: number): BusMessage[] {
    const dir = this.channelDir(sessionId, channel);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return [];
    }

    const messages: BusMessage[] = [];
    for (const file of files) {
      if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
      const ts = parseInt(file.split("-")[0], 10);
      if (isNaN(ts) || ts <= since) continue;
      try {
        const content = fs.readFileSync(path.join(dir, file), "utf-8");
        messages.push(JSON.parse(content) as BusMessage);
      } catch {
        // Skip corrupt / partially written files
      }
    }

    messages.sort((a, b) => a.timestamp - b.timestamp);
    return messages;
  }

  // ─── countMessages ───────────────────────────────────────────

  countMessages(sessionId: string, channel: string, since: number): number {
    const dir = this.channelDir(sessionId, channel);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return 0;
    }

    let count = 0;
    for (const file of files) {
      if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
      const ts = parseInt(file.split("-")[0], 10);
      if (!isNaN(ts) && ts > since) count++;
    }
    return count;
  }

  // ─── getChannels ─────────────────────────────────────────────

  getChannels(sessionId: string): string[] {
    const channelsDir = path.join(this.sessionDir(sessionId), "channels");
    try {
      return fs.readdirSync(channelsDir);
    } catch {
      return [];
    }
  }

  // ─── readCursor ──────────────────────────────────────────────

  readCursor(sessionId: string, agentId: string): CursorRecord {
    const file = this.cursorFile(sessionId, agentId);
    try {
      const content = fs.readFileSync(file, "utf-8");
      return JSON.parse(content) as CursorRecord;
    } catch {
      return {};
    }
  }

  // ─── updateCursor ────────────────────────────────────────────

  updateCursor(sessionId: string, agentId: string, updates: CursorRecord): void {
    const current = this.readCursor(sessionId, agentId);
    const merged: CursorRecord = { ...current };
    for (const [channel, ts] of Object.entries(updates)) {
      merged[channel] = Math.max(merged[channel] ?? 0, ts);
    }
    const file = this.cursorFile(sessionId, agentId);
    const tmpFile = file + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(merged), "utf-8");
    fs.renameSync(tmpFile, file);
  }
}
