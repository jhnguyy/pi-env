import { expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { editedFilePathFromToolResult, PendingPostEditFiles } from "../post-edit-files";

describeIfEnabled("dev-tools", "post-edit file collection", () => {
  it("extracts edit and write paths from tool results", () => {
    expect(editedFilePathFromToolResult({ toolName: "edit", input: { path: "/repo/a.ts" } })).toBe("/repo/a.ts");
    expect(editedFilePathFromToolResult({ toolName: "write", input: { file_path: "/repo/b.ts" } })).toBe("/repo/b.ts");
  });

  it("ignores failed, non-editing, and malformed tool results", () => {
    expect(editedFilePathFromToolResult({ toolName: "edit", isError: true, input: { path: "/repo/a.ts" } })).toBeNull();
    expect(editedFilePathFromToolResult({ toolName: "read", input: { path: "/repo/a.ts" } })).toBeNull();
    expect(editedFilePathFromToolResult({ toolName: "write", input: { path: 42 } })).toBeNull();
  });

  it("collects supported files once and drains atomically", () => {
    const pending = new PendingPostEditFiles((path) => path.endsWith(".ts"));

    pending.recordToolResult({ toolName: "edit", input: { path: "/repo/a.ts" } });
    pending.recordToolResult({ toolName: "write", input: { path: "/repo/a.ts" } });
    pending.recordToolResult({ toolName: "write", input: { path: "/repo/README.md" } });

    expect(pending.drain()).toEqual(["/repo/a.ts"]);
    expect(pending.drain()).toEqual([]);
  });
});
