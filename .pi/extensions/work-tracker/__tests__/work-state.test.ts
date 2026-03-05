import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { WorkStateStore } from "../work-state";

const TEST_PATH = "/tmp/test-work-state-unit.json";

function cleanup() {
  if (existsSync(TEST_PATH)) unlinkSync(TEST_PATH);
}

describe("WorkStateStore", () => {
  let store: WorkStateStore;
  beforeEach(() => {
    cleanup();
    store = new WorkStateStore(TEST_PATH);
  });
  afterEach(cleanup);

  it("returns empty state when file does not exist", () => {
    const state = store.read();
    expect(state.active).toBeNull();
    expect(state.recent).toEqual([]);
  });

  it("sets active work and persists it", () => {
    store.setActive({
      sessionId: "abc",
      task: "build the thing",
      branch: "feat/build",
      repo: "pi-env",
      startedAt: "2026-03-05T07:00:00Z",
      filesTouched: [],
    });
    const state = store.read();
    expect(state.active?.task).toBe("build the thing");
    expect(state.active?.branch).toBe("feat/build");
  });

  it("addFileTouched appends unique paths", () => {
    store.setActive({
      sessionId: "abc",
      task: "work",
      branch: null,
      repo: null,
      startedAt: "2026-03-05T07:00:00Z",
      filesTouched: [],
    });
    store.addFileTouched("/some/file.ts");
    store.addFileTouched("/other/file.ts");
    store.addFileTouched("/some/file.ts"); // duplicate — should not add
    expect(store.read().active?.filesTouched).toEqual(["/some/file.ts", "/other/file.ts"]);
  });

  it("complete clears active and prepends to recent", () => {
    store.setActive({
      sessionId: "abc",
      task: "work",
      branch: null,
      repo: null,
      startedAt: "2026-03-05T07:00:00Z",
      filesTouched: [],
    });
    store.complete({
      task: "work",
      branch: null,
      repo: null,
      outcome: "success",
      completedAt: "2026-03-05T08:00:00Z",
      durationMinutes: 60,
      summary: "done",
      filesChanged: [],
    });
    const state = store.read();
    expect(state.active).toBeNull();
    expect(state.recent).toHaveLength(1);
    expect(state.recent[0].outcome).toBe("success");
  });

  it("recent list is capped at 10 entries", () => {
    for (let i = 0; i < 12; i++) {
      store.complete({
        task: `task ${i}`,
        branch: null,
        repo: null,
        outcome: "success",
        completedAt: new Date().toISOString(),
        durationMinutes: 1,
        summary: "",
        filesChanged: [],
      });
    }
    expect(store.read().recent).toHaveLength(10);
  });

  it("clearActive nulls active without touching recent", () => {
    store.setActive({
      sessionId: "abc",
      task: "x",
      branch: null,
      repo: null,
      startedAt: new Date().toISOString(),
      filesTouched: [],
    });
    store.clearActive();
    expect(store.read().active).toBeNull();
  });
});
