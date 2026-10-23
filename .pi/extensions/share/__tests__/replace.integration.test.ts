import * as nodeFiles from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { fixture } from "./fixture";

describe("replace a private share", () => {
  it("confirms replacement and updates the same link with the previously inspected SHA", async () => {
    const f = fixture();
    await f.invoke();
    const [key, original] = [...f.github.contents][0];
    f.session.appendSessionInfo("a changed sensitive name");
    f.session.appendMessage({ role: "user", content: "updated synthetic export", timestamp: Date.now() });
    await f.invoke();
    expect(f.uploads).toHaveLength(2);
    expect(f.uploads[1]?.["sha"]).toBe(original.sha);
    expect(f.github.contents.get(key)?.path).toBe(original.path);
    expect(f.confirmations[1]).toMatch(/replac.*existing/i);
    expect(f.notices.filter((notice) => notice.startsWith("Shared privately:"))[1]).toBe(f.notices.find((notice) => notice.startsWith("Shared privately:")));
    const html = Buffer.from(String(f.uploads[1]?.["content"]), "base64").toString();
    const data = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
    expect(Buffer.from(data!, "base64").toString()).toContain("updated synthetic export");
  });

  it("does not export when the existing share cannot be inspected", async () => {
    const f = fixture();
    const path = `sessions/${f.session.getHeader()!.timestamp.slice(0, 10)}-${f.session.getSessionId().slice(-12)}.html`;
    f.github.errors.set(`repos/owner/private-exports/contents/${path}`, 403);
    await f.invoke();
    expect(f.confirmations).toEqual([]);
    expect(f.events).not.toContain("export");
    expect(f.uploads).toEqual([]);
  });

  it("does not replace a share when confirmation is declined", async () => {
    const f = fixture();
    await f.invoke();
    f.decline();
    await f.invoke();
    expect(f.uploads).toHaveLength(1);
  });

  it.each(["changed", "deleted"])("does not overwrite a share %s after confirmation", async (change) => {
    const f = fixture();
    await f.invoke();
    const [key, original] = [...f.github.contents][0];
    f.files.writeFile = async (...args) => {
      await nodeFiles.writeFile(...args);
      if (change === "deleted") f.github.contents.delete(key);
      else f.github.contents.set(key, { ...original, sha: "c".repeat(40) });
    };
    await f.invoke();
    expect(f.uploads).toHaveLength(1);
    expect(f.notices.join("\n")).toMatch(/changed.*confirmation/i);
  });

  it("does not replace a file created after confirmation of a new share", async () => {
    const f = fixture();
    const path = `sessions/${f.session.getHeader()!.timestamp.slice(0, 10)}-${f.session.getSessionId().slice(-12)}.html`;
    f.files.writeFile = async (...args) => {
      await nodeFiles.writeFile(...args);
      f.github.contents.set(`main:${path}`, { type: "file", name: path.slice(9), path, sha: "d".repeat(40), html_url: "https://github.com/owner/private-exports/blob/main/" + path });
    };
    await f.invoke();
    expect(f.uploads).toEqual([]);
    expect(f.notices.join("\n")).toMatch(/changed.*confirmation/i);
  });
});
