import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ActiveWork, CompletedWork, WorkState } from "./types";

const MAX_RECENT = 10;

export class WorkStateStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  read(): WorkState {
    try {
      if (existsSync(this.path)) {
        const raw = readFileSync(this.path, "utf8");
        return JSON.parse(raw) as WorkState;
      }
    } catch {
      // Corrupted or unreadable — start fresh
    }
    return { active: null, recent: [] };
  }

  setActive(active: ActiveWork): void {
    const state = this.read();
    state.active = active;
    this.write(state);
  }

  addFileTouched(filePath: string): void {
    const state = this.read();
    if (state.active && !state.active.filesTouched.includes(filePath)) {
      state.active.filesTouched.push(filePath);
      this.write(state);
    }
  }

  complete(completed: CompletedWork): void {
    const state = this.read();
    state.active = null;
    state.recent = [completed, ...state.recent].slice(0, MAX_RECENT);
    this.write(state);
  }

  clearActive(): void {
    const state = this.read();
    state.active = null;
    this.write(state);
  }

  private write(state: WorkState): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(state, null, 2) + "\n", "utf8");
  }
}
