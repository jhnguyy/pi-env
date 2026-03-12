import { describe, expect, it, afterEach, beforeEach } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { FileWatcher } from "../file-watcher";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describeIfEnabled("dev-tools", "FileWatcher", () => {
  // ─── Unit: debounce and filter logic (via real tmpdir) ─────────────────────

  describe("watch/unwatch lifecycle", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "lsp-fw-test-"));
    });

    afterEach(() => {
      try { rmSync(dir, { recursive: true }); } catch {}
    });

    it("starts watching a directory", () => {
      const watcher = new FileWatcher(() => {});
      watcher.watch(dir);
      expect(watcher.roots.has(dir)).toBe(true);
      watcher.close();
    });

    it("is idempotent — watching same root twice is safe", () => {
      const watcher = new FileWatcher(() => {});
      watcher.watch(dir);
      watcher.watch(dir); // second call should be no-op
      expect(watcher.roots.size).toBe(1);
      watcher.close();
    });

    it("unwatch removes the root", () => {
      const watcher = new FileWatcher(() => {});
      watcher.watch(dir);
      watcher.unwatch(dir);
      expect(watcher.roots.has(dir)).toBe(false);
      watcher.close();
    });

    it("close stops all watchers", () => {
      const watcher = new FileWatcher(() => {});
      watcher.watch(dir);
      watcher.close();
      expect(watcher.roots.size).toBe(0);
    });
  });

  describe("filtering", () => {
    // Test filter logic indirectly by creating a subclass that exposes handleChange
    class TestableWatcher extends FileWatcher {
      calls: string[] = [];
      constructor() {
        super((path) => this.calls.push(path), 0);
      }
      trigger(root: string, filename: string): void {
        // Access the private method by calling it directly via any cast
        (this as any).handleChange(root, filename);
      }
    }

    it("fires for .ts files", async () => {
      const w = new TestableWatcher();
      w.trigger("/project", "src/foo.ts");
      await new Promise((r) => setTimeout(r, 10));
      expect(w.calls).toContain("/project/src/foo.ts");
      w.close();
    });

    it("fires for .tsx files", async () => {
      const w = new TestableWatcher();
      w.trigger("/project", "app/Component.tsx");
      await new Promise((r) => setTimeout(r, 10));
      expect(w.calls).toContain("/project/app/Component.tsx");
      w.close();
    });

    it("ignores non-TS files", async () => {
      const w = new TestableWatcher();
      w.trigger("/project", "styles.css");
      w.trigger("/project", "README.md");
      w.trigger("/project", "image.png");
      await new Promise((r) => setTimeout(r, 10));
      expect(w.calls.length).toBe(0);
      w.close();
    });

    it("ignores node_modules", async () => {
      const w = new TestableWatcher();
      w.trigger("/project", "node_modules/lodash/index.ts");
      await new Promise((r) => setTimeout(r, 10));
      expect(w.calls.length).toBe(0);
      w.close();
    });

    it("ignores .git directory", async () => {
      const w = new TestableWatcher();
      w.trigger("/project", ".git/hooks/pre-commit.ts");
      await new Promise((r) => setTimeout(r, 10));
      expect(w.calls.length).toBe(0);
      w.close();
    });

    it("ignores dist directory", async () => {
      const w = new TestableWatcher();
      w.trigger("/project", "dist/bundle.js");
      await new Promise((r) => setTimeout(r, 10));
      expect(w.calls.length).toBe(0);
      w.close();
    });

    it("does not ignore src directory", async () => {
      const w = new TestableWatcher();
      w.trigger("/project", "src/utils.ts");
      await new Promise((r) => setTimeout(r, 10));
      expect(w.calls.length).toBe(1);
      w.close();
    });
  });

  describe("debounce", () => {
    class TestableWatcher extends FileWatcher {
      calls: string[] = [];
      constructor(debounceMs: number) {
        super((path) => this.calls.push(path), debounceMs);
      }
      trigger(root: string, filename: string): void {
        (this as any).handleChange(root, filename);
      }
    }

    it("debounces rapid changes to same file", async () => {
      const w = new TestableWatcher(50);
      w.trigger("/project", "src/foo.ts");
      w.trigger("/project", "src/foo.ts");
      w.trigger("/project", "src/foo.ts");
      await new Promise((r) => setTimeout(r, 100));
      expect(w.calls.length).toBe(1); // only one call despite 3 triggers
      w.close();
    });

    it("fires separately for different files", async () => {
      const w = new TestableWatcher(20);
      w.trigger("/project", "src/a.ts");
      w.trigger("/project", "src/b.ts");
      await new Promise((r) => setTimeout(r, 80));
      expect(w.calls.length).toBe(2);
      w.close();
    });

    it("clears pending timers on close", () => {
      const w = new TestableWatcher(1000); // long debounce
      w.trigger("/project", "src/foo.ts");
      expect(w.pendingTimers).toBe(1);
      w.close();
      expect(w.pendingTimers).toBe(0);
    });
  });
});
