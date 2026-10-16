import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchSessions } from "../search";

// The model workflow cannot reliably time cancellation while a filesystem stream is open.
it("cancels a real transcript scan without returning a false complete result", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-search-cancel-"));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const line = JSON.stringify({ type: "message", message: { role: "assistant", content: "unrelated ".repeat(2000) } });
    writeFileSync(join(root, "large.jsonl"), `${JSON.stringify({ type: "session", id: "large", cwd: "/fixture" })}\n${`${line}\n`.repeat(500)}`);
    const pending = searchSessions({ term: "missing" }, { sessionDir: root, signal: controller.signal });
    timer = setTimeout(() => controller.abort(), 10);
    expect(await pending).toEqual({ matches: [], truncated: false, cancelled: true });
    expect(await searchSessions({ term: "missing" }, { sessionDir: root, signal: controller.signal }))
      .toEqual({ matches: [], truncated: false, cancelled: true });
    expect(await searchSessions({ term: "missing" }, { sessionDir: root }))
      .toEqual({ matches: [], truncated: false, cancelled: false });
    mkdirSync(join(root, "empty"));
    expect(await searchSessions({ term: "missing" }, { sessionDir: join(root, "empty") }))
      .toEqual({ matches: [], truncated: false, cancelled: false });
  } finally {
    clearTimeout(timer);
    rmSync(root, { recursive: true, force: true });
  }
});
