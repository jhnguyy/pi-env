import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { handleRename, type HandlerDeps } from "../handlers";
import { pathToUri } from "../utils";
import { applyWorkspaceEdit } from "../workspace-edit";

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
      projectRoots: [root],
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

  it("allows an in-root segment whose name starts with dot-dot", async () => {
    const dotDotNamePath = join(root, "..foo.ts");
    await writeFile(dotDotNamePath, declarationContent, "utf8");
    const { deps } = dependencies({
      changes: {
        [pathToUri(dotDotNamePath)]: [
          { range: range(0, 13, 0, 21), newText: "accountName" },
        ],
      },
    });

    const response = await handleRename({
      id: 3,
      action: "rename",
      path: declarationPath,
      line: 1,
      character: 14,
      newName: "accountName",
    }, deps);

    expect(response.ok).toBe(true);
    await expect(readFile(dotDotNamePath, "utf8")).resolves.toBe(
      'export const accountName = "Ada";\n',
    );
  });

  it("rejects prefix sibling paths at the direct applier seam", async () => {
    const siblingRoot = `${root}-sibling`;
    const siblingPath = join(siblingRoot, "declaration.ts");
    await mkdir(siblingRoot);
    await writeFile(siblingPath, declarationContent, "utf8");
    try {
      await expect(applyWorkspaceEdit({
        changes: {
          [pathToUri(siblingPath)]: [
            { range: range(0, 13, 0, 21), newText: "accountName" },
          ],
        },
      }, { allowedRoots: [root] })).rejects.toThrow(/outside the allowed workspace roots/);
      await expect(readFile(siblingPath, "utf8")).resolves.toBe(declarationContent);
    } finally {
      await rm(siblingRoot, { recursive: true, force: true });
    }
  });

  it("rejects relative allowed roots at the direct applier seam", async () => {
    await expect(applyWorkspaceEdit({
      changes: {
        [pathToUri(declarationPath)]: [
          { range: range(0, 13, 0, 21), newText: "accountName" },
        ],
      },
    }, { allowedRoots: ["."] })).rejects.toThrow(/allowed roots must be absolute/);
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
    const linkSnapshot = vi.fn(() => ({ version: 1, content: declarationContent }));
    backend.getDocumentSnapshot = linkSnapshot;

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
    expect(linkSnapshot).toHaveBeenCalledWith(linkPath);
    expect(ensureFile.mock.calls.map(([path]) => path)).toEqual([linkPath, linkPath]);
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

  it("rejects a mixed in-scope and out-of-scope edit without partial writes", async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), "dev-tools-rename-outside-"));
    const outsidePath = join(outsideRoot, "outside.ts");
    const outsideContent = "console.log(userName);\n";
    await writeFile(outsidePath, outsideContent, "utf8");
    try {
      const { deps, invalidate } = dependencies({
        changes: {
          [pathToUri(declarationPath)]: [{ range: range(0, 13, 0, 21), newText: "accountName" }],
          [pathToUri(outsidePath)]: [{ range: range(0, 12, 0, 20), newText: "accountName" }],
        },
      });

      const response = await handleRename({
        id: 5,
        action: "rename",
        path: declarationPath,
        line: 1,
        character: 14,
        newName: "accountName",
      }, deps);

      expect(response.ok).toBe(false);
      await expect(readFile(declarationPath, "utf8")).resolves.toBe(declarationContent);
      await expect(readFile(outsidePath, "utf8")).resolves.toBe(outsideContent);
      expect(invalidate).not.toHaveBeenCalled();
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects a symlink escape without writes", async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), "dev-tools-rename-symlink-"));
    const outsideTarget = join(outsideRoot, "target.ts");
    const linkPath = join(root, "escape.ts");
    await writeFile(outsideTarget, declarationContent, "utf8");
    await symlink(outsideTarget, linkPath);
    try {
      const { deps, invalidate } = dependencies({
        changes: {
          [pathToUri(linkPath)]: [{ range: range(0, 13, 0, 21), newText: "accountName" }],
        },
      });

      const response = await handleRename({
        id: 6,
        action: "rename",
        path: linkPath,
        line: 1,
        character: 14,
        newName: "accountName",
      }, deps);

      expect(response.ok).toBe(false);
      await expect(readFile(outsideTarget, "utf8")).resolves.toBe(declarationContent);
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(invalidate).not.toHaveBeenCalled();
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects an allowed symlink whose real target has an unsupported backend before writes", async () => {
    const secondRoot = await mkdtemp(join(tmpdir(), "dev-tools-rename-symlink-backend-"));
    const realTarget = join(secondRoot, "target.ts");
    const linkPath = join(root, "cross-backend-link.ts");
    await writeFile(realTarget, declarationContent, "utf8");
    await symlink(realTarget, linkPath);
    try {
      const { backend, deps, invalidate } = dependencies({
        changes: {
          [pathToUri(linkPath)]: [
            { range: range(0, 13, 0, 21), newText: "accountName" },
          ],
        },
      });
      backend.projectRoots = [root, secondRoot];
      const originalGetBackend = deps.getBackend;
      deps.getBackend = ((path: string) => {
        if (path === realTarget) throw new Error("Unsupported file type: target.ts");
        return originalGetBackend(path);
      }) as HandlerDeps["getBackend"];

      const response = await handleRename({
        id: 7,
        action: "rename",
        path: linkPath,
        line: 1,
        character: 14,
        newName: "accountName",
      }, deps);

      expect(response.ok).toBe(false);
      await expect(readFile(realTarget, "utf8")).resolves.toBe(declarationContent);
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(invalidate).not.toHaveBeenCalled();
    } finally {
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  it("allows edits across multiple explicitly owned roots", async () => {
    const secondRoot = await mkdtemp(join(tmpdir(), "dev-tools-rename-second-"));
    const secondPath = join(secondRoot, "other.ts");
    const secondContent = "console.log(userName);\n";
    await writeFile(secondPath, secondContent, "utf8");
    try {
      const { backend, deps } = dependencies({
        changes: {
          [pathToUri(declarationPath)]: [{ range: range(0, 13, 0, 21), newText: "accountName" }],
          [pathToUri(secondPath)]: [{ range: range(0, 12, 0, 20), newText: "accountName" }],
        },
      });
      backend.projectRoots = [root, secondRoot];

      const response = await handleRename({
        id: 7,
        action: "rename",
        path: declarationPath,
        line: 1,
        character: 14,
        newName: "accountName",
      }, deps);

      expect(response.ok).toBe(true);
      await expect(readFile(declarationPath, "utf8")).resolves.toBe(
        'export const accountName = "Ada";\n',
      );
      await expect(readFile(secondPath, "utf8")).resolves.toBe("console.log(accountName);\n");
    } finally {
      await rm(secondRoot, { recursive: true, force: true });
    }
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
    deps.getBackend = ((path: string) => {
      if (path === unsupportedPath) throw new Error("Unsupported file type: unsupported.py");
      return originalGetBackend(path);
    }) as HandlerDeps["getBackend"];

    const response = await handleRename({
      id: 8,
      action: "rename",
      path: declarationPath,
      line: 1,
      character: 14,
      newName: "accountName",
    }, deps);

    expect(response.ok).toBe(false);
    await expect(readFile(declarationPath, "utf8")).resolves.toBe(declarationContent);
    await expect(readFile(unsupportedPath, "utf8")).resolves.toBe(unsupportedContent);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("routes snapshots and refreshes through each target backend", async () => {
    const secondRoot = await mkdtemp(join(tmpdir(), "dev-tools-rename-backend-"));
    const secondPath = join(secondRoot, "other.ts");
    const secondContent = "console.log(userName);\n";
    await writeFile(secondPath, secondContent, "utf8");
    try {
      const { backend: sourceBackend, deps } = dependencies({
        documentChanges: [
          {
            textDocument: { uri: pathToUri(declarationPath), version: 1 },
            edits: [{ range: range(0, 13, 0, 21), newText: "accountName" }],
          },
          {
            textDocument: { uri: pathToUri(secondPath), version: 2 },
            edits: [{ range: range(0, 12, 0, 20), newText: "accountName" }],
          },
        ],
      });
      sourceBackend.projectRoots = [root, secondRoot];
      const secondSnapshot = vi.fn(() => ({ version: 2, content: secondContent }));
      const secondEnsureFile = vi.fn(async (path: string) => pathToUri(path));
      const secondBackend = {
        ...sourceBackend,
        getDocumentSnapshot: secondSnapshot,
        ensureFile: secondEnsureFile,
      };
      const originalGetBackend = deps.getBackend;
      deps.getBackend = ((path: string) => (
        path === secondPath ? secondBackend : originalGetBackend(path)
      )) as HandlerDeps["getBackend"];

      const response = await handleRename({
        id: 9,
        action: "rename",
        path: declarationPath,
        line: 1,
        character: 14,
        newName: "accountName",
      }, deps);

      expect(response.ok).toBe(true);
      expect(secondSnapshot).toHaveBeenCalledWith(secondPath);
      expect(secondEnsureFile).toHaveBeenCalledWith(secondPath);
    } finally {
      await rm(secondRoot, { recursive: true, force: true });
    }
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
