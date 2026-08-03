import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { handleRename, type HandlerDeps } from "../handlers";
import { pathToUri } from "../utils";

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

describeIfEnabled("dev-tools", "rename action", () => {
  let root: string;
  let declarationPath: string;
  let usagePath: string;
  let declarationContent: string;
  let usageContent: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-tools-rename-"));
    declarationPath = join(root, "declaration.ts");
    usagePath = join(root, "usage.ts");
    declarationContent = 'export const userName = "Ada";\n';
    usageContent = 'import { userName } from "./declaration";\nconsole.log(userName);\n';
    await Promise.all([
      writeFile(declarationPath, declarationContent, "utf8"),
      writeFile(usagePath, usageContent, "utf8"),
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function dependencies(workspaceEdit: unknown) {
    const ensureFile = vi.fn(async (path: string) => pathToUri(path));
    const lspRequest = vi.fn(async () => ({ jsonrpc: "2.0", id: 1, result: workspaceEdit }));
    const invalidate = vi.fn();
    const backend = {
      ensureFile,
      getProjectRoot: () => root,
      getDocumentSnapshot: (path: string) => ({
        version: 1,
        content: path === declarationPath ? declarationContent : usageContent,
      }),
      lspRequest,
    };
    const deps = {
      getBackend: () => backend,
      getWorkspaceSymbolBackends: () => [],
      backends: [],
      fileCache: { invalidate },
      getIdleMs: () => 0,
    } as unknown as HandlerDeps;
    return { backend, deps, ensureFile, invalidate, lspRequest };
  }

  it("applies one LSP rename across files and refreshes daemon state", async () => {
    const { deps, ensureFile, invalidate, lspRequest } = dependencies({
      changes: {
        [pathToUri(declarationPath)]: [{ range: range(0, 13, 0, 21), newText: "accountName" }],
        [pathToUri(usagePath)]: [
          { range: range(0, 9, 0, 17), newText: "accountName" },
          { range: range(1, 12, 1, 20), newText: "accountName" },
        ],
      },
    });

    const response = await handleRename(
      {
        id: 1,
        action: "rename",
        path: declarationPath,
        line: 1,
        character: 14,
        newName: "accountName",
      },
      deps,
    );

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      action: "rename",
      path: declarationPath,
      line: 1,
      character: 14,
      newName: "accountName",
      totalEdits: 3,
      files: [
        { absolutePath: declarationPath, relativePath: "declaration.ts", editCount: 1 },
        { absolutePath: usagePath, relativePath: "usage.ts", editCount: 2 },
      ],
    });
    await expect(readFile(declarationPath, "utf8")).resolves.toBe(
      'export const accountName = "Ada";\n',
    );
    await expect(readFile(usagePath, "utf8")).resolves.toBe(
      'import { accountName } from "./declaration";\nconsole.log(accountName);\n',
    );
    expect(lspRequest).toHaveBeenCalledWith("textDocument/rename", {
      textDocument: { uri: pathToUri(declarationPath) },
      position: { line: 0, character: 13 },
      newName: "accountName",
    });
    expect(invalidate.mock.calls.map(([path]) => path)).toEqual([declarationPath, usagePath]);
    expect(ensureFile.mock.calls.map(([path]) => path)).toEqual([
      declarationPath,
      declarationPath,
      usagePath,
    ]);
  });

  it("applies the documentChanges form of a workspace edit", async () => {
    const { deps } = dependencies({
      documentChanges: [
        {
          textDocument: { uri: pathToUri(usagePath), version: 1 },
          edits: [{ range: range(1, 12, 1, 20), newText: "accountName" }],
        },
      ],
    });

    const response = await handleRename(
      {
        id: 2,
        action: "rename",
        path: declarationPath,
        line: 1,
        character: 14,
        newName: "accountName",
      },
      deps,
    );

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      totalEdits: 1,
      files: [{ absolutePath: usagePath, editCount: 1 }],
    });
    await expect(readFile(usagePath, "utf8")).resolves.toBe(
      'import { userName } from "./declaration";\nconsole.log(accountName);\n',
    );
  });

  it("preserves a symlink while it edits the linked file", async () => {
    const targetPath = join(root, "target.ts");
    const linkPath = join(root, "link.ts");
    await writeFile(targetPath, declarationContent, "utf8");
    await symlink(targetPath, linkPath);
    const { deps } = dependencies({
      changes: {
        [pathToUri(linkPath)]: [
          { range: range(0, 13, 0, 21), newText: "accountName" },
        ],
      },
    });

    const response = await handleRename({
      id: 3,
      action: "rename",
      path: linkPath,
      line: 1,
      character: 14,
      newName: "accountName",
    }, deps);

    expect(response.ok).toBe(true);
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    await expect(readFile(targetPath, "utf8")).resolves.toBe(
      'export const accountName = "Ada";\n',
    );
  });

  it("rejects a stale versioned workspace edit", async () => {
    const { backend, deps, ensureFile, invalidate } = dependencies({
      documentChanges: [
        {
          textDocument: { uri: pathToUri(usagePath), version: 1 },
          edits: [{ range: range(1, 12, 1, 20), newText: "accountName" }],
        },
      ],
    });
    backend.getDocumentSnapshot = () => ({ version: 2, content: usageContent });

    const response = await handleRename(
      {
        id: 3,
        action: "rename",
        path: declarationPath,
        line: 1,
        character: 14,
        newName: "accountName",
      },
      deps,
    );

    expect(response.ok).toBe(false);
    await expect(readFile(usagePath, "utf8")).resolves.toBe(usageContent);
    expect(invalidate).not.toHaveBeenCalled();
    expect(ensureFile).toHaveBeenCalledTimes(1);
  });

  it("rejects a relative daemon path before the LSP request", async () => {
    const { deps, ensureFile, lspRequest } = dependencies({});

    const response = await handleRename({
      id: 4,
      action: "rename",
      path: "declaration.ts",
      line: 1,
      character: 14,
      newName: "accountName",
    }, deps);

    expect(response.ok).toBe(false);
    expect(ensureFile).not.toHaveBeenCalled();
    expect(lspRequest).not.toHaveBeenCalled();
  });

  it("rejects an invalid daemon position before the LSP request", async () => {
    const { deps, ensureFile, lspRequest } = dependencies({});

    const response = await handleRename(
      {
        id: 3,
        action: "rename",
        path: declarationPath,
        line: 1.5,
        character: 14,
        newName: "accountName",
      },
      deps,
    );

    expect(response.ok).toBe(false);
    expect(ensureFile).not.toHaveBeenCalled();
    expect(lspRequest).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "malformed edits",
      edit: (declarationUri: string) => ({
        changes: {
          [declarationUri]: [{ range: range(0, 13, 0, 21), newText: 42 }],
        },
      }),
    },
    {
      name: "unsupported resource operations",
      edit: (declarationUri: string) => ({
        documentChanges: [
          { kind: "rename", oldUri: declarationUri, newUri: `${declarationUri}.renamed` },
        ],
      }),
    },
    {
      name: "overlapping edits",
      edit: (declarationUri: string) => ({
        changes: {
          [declarationUri]: [
            { range: range(0, 13, 0, 21), newText: "accountName" },
            { range: range(0, 15, 0, 20), newText: "otherName" },
          ],
        },
      }),
    },
    {
      name: "out-of-bounds edits",
      edit: (declarationUri: string) => ({
        changes: {
          [declarationUri]: [{ range: range(0, 13, 0, 21), newText: "accountName" }],
          [pathToUri(usagePath)]: [{ range: range(99, 0, 99, 8), newText: "accountName" }],
        },
      }),
    },
  ])("rejects $name without partial writes", async ({ edit }) => {
    const { deps, ensureFile, invalidate } = dependencies(edit(pathToUri(declarationPath)));

    const response = await handleRename(
      {
        id: 2,
        action: "rename",
        path: declarationPath,
        line: 1,
        character: 14,
        newName: "accountName",
      },
      deps,
    );

    expect(response.ok).toBe(false);
    await expect(readFile(declarationPath, "utf8")).resolves.toBe(declarationContent);
    await expect(readFile(usagePath, "utf8")).resolves.toBe(usageContent);
    expect(invalidate).not.toHaveBeenCalled();
    expect(ensureFile).toHaveBeenCalledTimes(1);
  });
});
