import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as TempDir from "../../../src/testing/temp-dir";
import { handleRename, type RenameBackend, type RenameHandlerDeps } from "../handlers";
import { pathToUri } from "../utils";
import { applyWorkspaceEdit } from "../workspace-edit";

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

describe("rename action", () => {
  let root: string;
  let declarationPath: string;
  let usagePath: string;
  let declarationContent: string;
  let usageContent: string;

  beforeEach(async () => {
    root = await TempDir.forTest("dev-tools-rename-");
    declarationPath = join(root, "declaration.ts");
    usagePath = join(root, "usage.ts");
    declarationContent = 'export const userName = "Ada";\n';
    usageContent = 'import { userName } from "./declaration";\nconsole.log(userName);\n';
    await Promise.all([
      writeFile(declarationPath, declarationContent, "utf8"),
      writeFile(usagePath, usageContent, "utf8"),
    ]);
  });

  function dependencies(workspaceEdit: unknown) {
    const ensureFile = vi.fn(async (path: string) => pathToUri(path));
    const lspRequest = vi.fn(async () => ({
      jsonrpc: "2.0" as const,
      id: 1,
      result: workspaceEdit,
    }));
    const invalidate = vi.fn();
    const backend = {
      ensureFile,
      getProjectRoot: () => root,
      getDocumentSnapshot: (path: string) => ({
        version: 1,
        content: path === declarationPath ? declarationContent : usageContent,
      }),
      lspRequest,
      recordSemanticResult: vi.fn(),
      projectRoots: [root],
    } satisfies RenameBackend;
    const deps = {
      getBackend: (_path: string) => backend,
      fileCache: { invalidate },
    } satisfies RenameHandlerDeps;
    return { backend, deps, ensureFile, invalidate, lspRequest };
  }

  it.each([false, true])(
    "waits for every refresh and preserves errors without rolling back (target fails: %s)",
    async (targetFails) => {
      const { backend, deps } = dependencies({
        changes: {
          [pathToUri(declarationPath)]: [{ range: range(0, 13, 0, 21), newText: "accountName" }],
          [pathToUri(usagePath)]: [{ range: range(1, 12, 1, 20), newText: "accountName" }],
        },
      });
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const refreshing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let sourceOpened = false;
      let completed = false;
      backend.ensureFile.mockImplementation(async (path) => {
        if (!sourceOpened) {
          sourceOpened = true;
          return pathToUri(path);
        }
        if (path === declarationPath) throw new Error("source refresh failed");
        entered();
        await blocked;
        completed = true;
        if (targetFails) throw new Error("target refresh failed");
        return pathToUri(path);
      });
      let settled = false;
      const pending = handleRename(
        {
          id: 1,
          action: "rename",
          path: declarationPath,
          line: 1,
          character: 14,
          newName: "accountName",
        },
        deps,
      ).then((response) => {
        settled = true;
        return response;
      });
      try {
        await refreshing;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
      } finally {
        release();
      }
      expect(await pending).toMatchObject({
        ok: false,
        error: targetFails
          ? "Rename refresh failed: source refresh failed; target refresh failed"
          : "source refresh failed",
      });
      expect(completed).toBe(true);
      expect(await readFile(declarationPath, "utf8")).toContain("accountName");
      expect(await readFile(usagePath, "utf8")).toContain("console.log(accountName)");
    },
  );

  it.each(["changes", "documentChanges"] as const)(
    "applies %s across distinct owners and roots, including a dot-dot filename",
    async (form) => {
      const sourceRoot = join(root, "source-root");
      const secondRoot = join(root, "second-root");
      await Promise.all([mkdir(sourceRoot), mkdir(secondRoot)]);
      declarationPath = join(sourceRoot, "declaration.ts");
      await writeFile(declarationPath, declarationContent, "utf8");
      usagePath = join(secondRoot, "..foo.ts");
      await writeFile(usagePath, usageContent, "utf8");
      const changes = {
        [pathToUri(declarationPath)]: [{ range: range(0, 13, 0, 21), newText: "accountName" }],
        [pathToUri(usagePath)]: [
          { range: range(0, 9, 0, 17), newText: "accountName" },
          { range: range(1, 12, 1, 20), newText: "accountName" },
        ],
      };
      const { backend, deps, ensureFile, invalidate, lspRequest } = dependencies(
        form === "changes"
          ? { changes }
          : {
              documentChanges: Object.entries(changes).map(([uri, edits], index) => ({
                textDocument: { uri, version: index + 1 },
                edits,
              })),
            },
      );
      backend.projectRoots = [sourceRoot, secondRoot];
      backend.getProjectRoot = () => sourceRoot;
      const sourceSnapshot = vi.fn(() => ({ version: 1, content: declarationContent }));
      const targetSnapshot = vi.fn(() => ({ version: 2, content: usageContent }));
      backend.getDocumentSnapshot = sourceSnapshot;
      const sourceRefreshed = new Map<string, string>();
      const targetRefreshed = new Map<string, string>();
      ensureFile.mockImplementation(async (path) => {
        const content = await readFile(path, "utf8");
        if (content.includes("accountName")) sourceRefreshed.set(path, content);
        return pathToUri(path);
      });
      const targetEnsure = vi.fn(async (path: string) => {
        targetRefreshed.set(path, await readFile(path, "utf8"));
        return pathToUri(path);
      });
      const targetBackend = {
        ...backend,
        projectRoots: [secondRoot],
        getProjectRoot: () => secondRoot,
        getDocumentSnapshot: targetSnapshot,
        ensureFile: targetEnsure,
      } satisfies RenameBackend;
      deps.getBackend = (path: string) => (path === usagePath ? targetBackend : backend);
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
          { absolutePath: usagePath, relativePath: usagePath, editCount: 2 },
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
      expect(sourceRefreshed).toEqual(
        new Map([[declarationPath, 'export const accountName = "Ada";\n']]),
      );
      expect(targetRefreshed).toEqual(
        new Map([
          [usagePath, 'import { accountName } from "./declaration";\nconsole.log(accountName);\n'],
        ]),
      );
      expect(targetEnsure).toHaveBeenCalledWith(usagePath);
      if (form === "documentChanges") {
        expect(sourceSnapshot.mock.calls).toEqual([[declarationPath]]);
        expect(targetSnapshot.mock.calls).toEqual([[usagePath]]);
      }
    },
  );

  it("rejects prefix sibling paths at the direct applier seam", async () => {
    const siblingRoot = `${root}-sibling`;
    const siblingPath = join(siblingRoot, "declaration.ts");
    await mkdir(siblingRoot);
    await writeFile(siblingPath, declarationContent, "utf8");
    try {
      await expect(
        applyWorkspaceEdit(
          {
            changes: {
              [pathToUri(siblingPath)]: [{ range: range(0, 13, 0, 21), newText: "accountName" }],
            },
          },
          { allowedRoots: [root] },
        ),
      ).rejects.toThrow(/outside the allowed workspace roots/);
      await expect(readFile(siblingPath, "utf8")).resolves.toBe(declarationContent);
    } finally {
      await rm(siblingRoot, { recursive: true, force: true });
    }
  });

  it("rejects relative allowed roots at the direct applier seam", async () => {
    await expect(
      applyWorkspaceEdit(
        {
          changes: {
            [pathToUri(declarationPath)]: [{ range: range(0, 13, 0, 21), newText: "accountName" }],
          },
        },
        { allowedRoots: ["."] },
      ),
    ).rejects.toThrow(/allowed roots must be absolute/);
    await expect(readFile(declarationPath, "utf8")).resolves.toBe(declarationContent);
  });

  it("preserves a symlink while it edits the linked file", async () => {
    const targetPath = join(root, "target.ts");
    const linkPath = join(root, "link.ts");
    await writeFile(targetPath, declarationContent, "utf8");
    await symlink(targetPath, linkPath);
    const { backend, deps, ensureFile } = dependencies({
      documentChanges: [
        {
          textDocument: { uri: pathToUri(linkPath), version: 1 },
          edits: [{ range: range(0, 13, 0, 21), newText: "accountName" }],
        },
      ],
    });
    let refreshedContent: string | undefined;
    ensureFile.mockImplementation(async (path) => {
      refreshedContent = await readFile(path, "utf8");
      return pathToUri(path);
    });
    const linkSnapshot = vi.fn(() => ({ version: 1, content: declarationContent }));
    backend.getDocumentSnapshot = linkSnapshot;

    const response = await handleRename(
      {
        id: 3,
        action: "rename",
        path: linkPath,
        line: 1,
        character: 14,
        newName: "accountName",
      },
      deps,
    );

    expect(response.ok).toBe(true);
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    await expect(readFile(targetPath, "utf8")).resolves.toBe('export const accountName = "Ada";\n');
    expect(linkSnapshot).toHaveBeenCalledWith(linkPath);
    expect(refreshedContent).toBe('export const accountName = "Ada";\n');
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

    const response = await handleRename(
      {
        id: 4,
        action: "rename",
        path: "declaration.ts",
        line: 1,
        character: 14,
        newName: "accountName",
      },
      deps,
    );

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

  it("rejects a mixed in-scope and out-of-scope edit without partial writes", async () => {
    const outsideRoot = await TempDir.forTest("dev-tools-rename-outside-");
    const outsidePath = join(outsideRoot, "outside.ts");
    const outsideContent = "console.log(userName);\n";
    await writeFile(outsidePath, outsideContent, "utf8");
    const { deps, invalidate } = dependencies({
      changes: {
        [pathToUri(declarationPath)]: [{ range: range(0, 13, 0, 21), newText: "accountName" }],
        [pathToUri(outsidePath)]: [{ range: range(0, 12, 0, 20), newText: "accountName" }],
      },
    });

    const response = await handleRename(
      {
        id: 5,
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
    await expect(readFile(outsidePath, "utf8")).resolves.toBe(outsideContent);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("rejects a symlink escape without writes", async () => {
    const outsideRoot = await TempDir.forTest("dev-tools-rename-symlink-");
    const outsideTarget = join(outsideRoot, "target.ts");
    const linkPath = join(root, "escape.ts");
    await writeFile(outsideTarget, declarationContent, "utf8");
    await symlink(outsideTarget, linkPath);
    const { deps, invalidate } = dependencies({
      changes: {
        [pathToUri(linkPath)]: [{ range: range(0, 13, 0, 21), newText: "accountName" }],
      },
    });

    const response = await handleRename(
      {
        id: 6,
        action: "rename",
        path: linkPath,
        line: 1,
        character: 14,
        newName: "accountName",
      },
      deps,
    );

    expect(response.ok).toBe(false);
    await expect(readFile(outsideTarget, "utf8")).resolves.toBe(declarationContent);
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("rejects an allowed symlink whose real target has an unsupported backend before writes", async () => {
    const secondRoot = await TempDir.forTest("dev-tools-rename-symlink-backend-");
    const realTarget = join(secondRoot, "target.ts");
    const linkPath = join(root, "cross-backend-link.ts");
    await writeFile(realTarget, declarationContent, "utf8");
    await symlink(realTarget, linkPath);
    const { backend, deps, invalidate } = dependencies({
      changes: {
        [pathToUri(linkPath)]: [{ range: range(0, 13, 0, 21), newText: "accountName" }],
      },
    });
    backend.projectRoots = [root, secondRoot];
    const originalGetBackend = deps.getBackend;
    deps.getBackend = (path: string) => {
      if (path === realTarget) throw new Error("Unsupported file type: target.ts");
      return originalGetBackend(path);
    };

    const response = await handleRename(
      {
        id: 7,
        action: "rename",
        path: linkPath,
        line: 1,
        character: 14,
        newName: "accountName",
      },
      deps,
    );

    expect(response.ok).toBe(false);
    await expect(readFile(realTarget, "utf8")).resolves.toBe(declarationContent);
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("rejects an unsupported target before any write", async () => {
    const unsupportedPath = join(root, "unsupported.py");
    const unsupportedContent = "print('userName')\n";
    await writeFile(unsupportedPath, unsupportedContent, "utf8");
    const { deps, invalidate } = dependencies({
      changes: {
        [pathToUri(declarationPath)]: [{ range: range(0, 13, 0, 21), newText: "accountName" }],
        [pathToUri(unsupportedPath)]: [{ range: range(0, 7, 0, 15), newText: "accountName" }],
      },
    });
    const originalGetBackend = deps.getBackend;
    deps.getBackend = (path: string) => {
      if (path === unsupportedPath) throw new Error("Unsupported file type: unsupported.py");
      return originalGetBackend(path);
    };

    const response = await handleRename(
      {
        id: 8,
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
    await expect(readFile(unsupportedPath, "utf8")).resolves.toBe(unsupportedContent);
    expect(invalidate).not.toHaveBeenCalled();
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
