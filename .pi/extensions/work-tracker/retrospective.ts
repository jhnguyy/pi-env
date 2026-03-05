import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
}
