import { randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect } from "effect";

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspTextEdit {
  range: LspRange;
  newText: string;
}

interface WorkspaceFileEdits {
  absolutePath: string;
  edits: LspTextEdit[];
  expectedVersion?: number | null;
}

export interface WorkspaceDocumentSnapshot {
  version: number;
  content: string;
}

export interface ApplyWorkspaceEditOptions {
  getDocumentSnapshot?: (absolutePath: string) => WorkspaceDocumentSnapshot | undefined;
}

export interface AppliedWorkspaceFileEdit {
  absolutePath: string;
  editCount: number;
}

export interface AppliedWorkspaceEdit {
  files: AppliedWorkspaceFileEdit[];
  totalEdits: number;
}

export class WorkspaceEditApplyError extends Data.TaggedError("WorkspaceEditApplyError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function workspaceEditError(message: string, cause?: unknown): WorkspaceEditApplyError {
  return new WorkspaceEditApplyError({ message, ...(cause === undefined ? {} : { cause }) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePosition(value: unknown, label: string): LspPosition {
  if (!isRecord(value)) throw workspaceEditError(`${label} must be an object.`);
  const { line, character } = value;
  if (!Number.isInteger(line) || (line as number) < 0) {
    throw workspaceEditError(`${label}.line must be a non-negative integer.`);
  }
  if (!Number.isInteger(character) || (character as number) < 0) {
    throw workspaceEditError(`${label}.character must be a non-negative integer.`);
  }
  return { line: line as number, character: character as number };
}

function parseTextEdit(value: unknown, label: string): LspTextEdit {
  if (!isRecord(value)) throw workspaceEditError(`${label} must be an object.`);
  if (typeof value.newText !== "string") {
    throw workspaceEditError(`${label}.newText must be a string.`);
  }
  if (!isRecord(value.range)) throw workspaceEditError(`${label}.range must be an object.`);
  return {
    range: {
      start: parsePosition(value.range.start, `${label}.range.start`),
      end: parsePosition(value.range.end, `${label}.range.end`),
    },
    newText: value.newText,
  };
}

function filePathFromUri(uri: string): string {
  let url: URL;
  try {
    url = new URL(uri);
  } catch (cause) {
    throw workspaceEditError(`Workspace edit URI is invalid: ${uri}`, cause);
  }
  if (url.protocol !== "file:") {
    throw workspaceEditError(`Workspace edit URI must use the file scheme: ${uri}`);
  }
  try {
    return fileURLToPath(url);
  } catch (cause) {
    throw workspaceEditError(
      `Workspace edit URI cannot be converted to a file path: ${uri}`,
      cause,
    );
  }
}

function parseWorkspaceEdit(value: unknown): WorkspaceFileEdits[] {
  if (!isRecord(value)) throw workspaceEditError("Workspace edit must be an object.");
  const hasChanges = value.changes !== undefined;
  const hasDocumentChanges = value.documentChanges !== undefined;
  if (hasChanges && hasDocumentChanges) {
    throw workspaceEditError("Workspace edit cannot contain both changes and documentChanges.");
  }

  const files = new Map<string, WorkspaceFileEdits>();
  const addEdits = (
    uri: string,
    rawEdits: unknown,
    label: string,
    expectedVersion?: number | null,
  ) => {
    if (!Array.isArray(rawEdits)) throw workspaceEditError(`${label} must be an array.`);
    const absolutePath = filePathFromUri(uri);
    const edits = rawEdits.map((edit, index) => parseTextEdit(edit, `${label}[${index}]`));
    if (edits.length === 0) return;
    const existing = files.get(absolutePath);
    if (
      existing?.expectedVersion !== undefined &&
      expectedVersion !== undefined &&
      existing.expectedVersion !== expectedVersion
    ) {
      throw workspaceEditError(`${absolutePath} has conflicting document versions.`);
    }
    files.set(absolutePath, {
      absolutePath,
      edits: [...(existing?.edits ?? []), ...edits],
      expectedVersion: existing?.expectedVersion ?? expectedVersion,
    });
  };

  if (hasChanges) {
    if (!isRecord(value.changes))
      throw workspaceEditError("Workspace edit changes must be an object.");
    for (const [uri, edits] of Object.entries(value.changes)) {
      addEdits(uri, edits, `changes[${JSON.stringify(uri)}]`);
    }
  }

  if (hasDocumentChanges) {
    if (!Array.isArray(value.documentChanges)) {
      throw workspaceEditError("Workspace edit documentChanges must be an array.");
    }
    value.documentChanges.forEach((change, index) => {
      const label = `documentChanges[${index}]`;
      if (!isRecord(change)) throw workspaceEditError(`${label} must be an object.`);
      if (typeof change.kind === "string") {
        throw workspaceEditError(`${label} resource operation ${change.kind} is not supported.`);
      }
      if (!isRecord(change.textDocument) || typeof change.textDocument.uri !== "string") {
        throw workspaceEditError(`${label}.textDocument.uri must be a string.`);
      }
      const version = change.textDocument.version;
      if (
        version !== undefined &&
        version !== null &&
        (!Number.isInteger(version) || (version as number) < 0)
      ) {
        throw workspaceEditError(
          `${label}.textDocument.version must be null or a non-negative integer.`,
        );
      }
      addEdits(
        change.textDocument.uri,
        change.edits,
        `${label}.edits`,
        version as number | null | undefined,
      );
    });
  }

  return [...files.values()];
}

interface LineBounds {
  start: number;
  end: number;
}

function getLineBounds(content: string): LineBounds[] {
  const lines: LineBounds[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (character === "\r") {
      lines.push({ start, end: index });
      if (content[index + 1] === "\n") index++;
      start = index + 1;
    } else if (character === "\n") {
      lines.push({ start, end: index });
      start = index + 1;
    }
  }
  lines.push({ start, end: content.length });
  return lines;
}

function positionOffset(lines: LineBounds[], position: LspPosition, label: string): number {
  const line = lines[position.line];
  if (!line) throw workspaceEditError(`${label} line ${position.line} is out of bounds.`);
  if (position.character > line.end - line.start) {
    throw workspaceEditError(`${label} character ${position.character} is out of bounds.`);
  }
  return line.start + position.character;
}

function applyTextEdits(content: string, file: WorkspaceFileEdits): string {
  const lines = getLineBounds(content);
  const edits = file.edits.map((edit, index) => {
    const start = positionOffset(
      lines,
      edit.range.start,
      `${file.absolutePath} edit ${index} start`,
    );
    const end = positionOffset(lines, edit.range.end, `${file.absolutePath} edit ${index} end`);
    if (end < start)
      throw workspaceEditError(`${file.absolutePath} edit ${index} has a reversed range.`);
    return { start, end, newText: edit.newText, index };
  });

  const ascending = [...edits].sort(
    (left, right) => left.start - right.start || right.end - left.end || left.index - right.index,
  );
  for (let index = 1; index < ascending.length; index++) {
    if (ascending[index]!.start < ascending[index - 1]!.end) {
      throw workspaceEditError(`${file.absolutePath} contains overlapping text edits.`);
    }
  }

  const descending = [...edits].sort(
    (left, right) => right.start - left.start || right.index - left.index,
  );
  return descending.reduce(
    (updated, edit) => updated.slice(0, edit.start) + edit.newText + updated.slice(edit.end),
    content,
  );
}

interface PreparedWorkspaceFileEdit extends WorkspaceFileEdits {
  writePath: string;
  content: string;
  updatedContent: string;
}

interface StagedWorkspaceFileEdit extends PreparedWorkspaceFileEdit {
  stagedPath: string;
  backupPath: string;
}

function siblingTemporaryPath(absolutePath: string, role: "staged" | "backup"): string {
  return join(
    dirname(absolutePath),
    `.${basename(absolutePath)}.pi-dev-tools-${role}-${process.pid}-${randomUUID()}`,
  );
}

async function stageWorkspaceFile(
  update: PreparedWorkspaceFileEdit,
): Promise<StagedWorkspaceFileEdit> {
  const stagedPath = siblingTemporaryPath(update.writePath, "staged");
  const backupPath = siblingTemporaryPath(update.writePath, "backup");
  const source = await stat(update.writePath);
  const handle = await open(stagedPath, "wx", source.mode);
  try {
    await handle.writeFile(update.updatedContent, "utf8");
    await handle.chmod(source.mode);
    await handle.sync();
    await handle.close();
  } catch (cause) {
    await handle.close().catch(() => {});
    await rm(stagedPath, { force: true }).catch(() => {});
    throw cause;
  }
  return { ...update, stagedPath, backupPath };
}

async function replaceWorkspaceFiles(updates: PreparedWorkspaceFileEdit[]): Promise<void> {
  const staged: StagedWorkspaceFileEdit[] = [];
  try {
    for (const update of updates) staged.push(await stageWorkspaceFile(update));
    const currentContents = await Promise.all(
      staged.map((update) => readFile(update.writePath, "utf8")),
    );
    for (let index = 0; index < staged.length; index++) {
      if (currentContents[index] !== staged[index]!.content) {
        throw workspaceEditError(
          `${staged[index]!.absolutePath} changed while the workspace edit was staged.`,
        );
      }
    }
  } catch (cause) {
    await Promise.allSettled(staged.map((update) => rm(update.stagedPath, { force: true })));
    throw cause;
  }

  const backedUp: StagedWorkspaceFileEdit[] = [];
  try {
    for (const update of staged) {
      await rename(update.writePath, update.backupPath);
      backedUp.push(update);
      await rename(update.stagedPath, update.writePath);
    }
  } catch (cause) {
    const rollback = await Promise.allSettled(
      [...backedUp].reverse().map(async (update) => {
        await rm(update.writePath, { force: true });
        await rename(update.backupPath, update.writePath);
      }),
    );
    await Promise.allSettled(staged.map((update) => rm(update.stagedPath, { force: true })));
    if (rollback.some((result) => result.status === "rejected")) {
      throw workspaceEditError("Workspace edit failed and rollback was incomplete.", cause);
    }
    throw cause;
  }

  await Promise.allSettled(backedUp.map((update) => rm(update.backupPath, { force: true })));
}

export function applyWorkspaceEditEffect(
  value: unknown,
  options: ApplyWorkspaceEditOptions = {},
): Effect.Effect<AppliedWorkspaceEdit, WorkspaceEditApplyError> {
  return Effect.tryPromise({
    try: async () => {
      const files = parseWorkspaceEdit(value);
      const sourceFiles = await Promise.all(
        files.map(async (file) => {
          const writePath = await realpath(file.absolutePath);
          const content = await readFile(writePath, "utf8");
          if (file.expectedVersion !== undefined && file.expectedVersion !== null) {
            const snapshot = options.getDocumentSnapshot?.(file.absolutePath);
            if (!snapshot || snapshot.version !== file.expectedVersion) {
              throw workspaceEditError(
                `${file.absolutePath} document version does not match the workspace edit.`,
              );
            }
            if (snapshot.content !== content) {
              throw workspaceEditError(
                `${file.absolutePath} changed after the language server produced the workspace edit.`,
              );
            }
          }
          return { ...file, writePath, content };
        }),
      );
      if (new Set(sourceFiles.map((file) => file.writePath)).size !== sourceFiles.length) {
        throw workspaceEditError("Workspace edit contains multiple paths to the same file.");
      }
      const updates = sourceFiles.map((file) => ({
        ...file,
        updatedContent: applyTextEdits(file.content, file),
      }));

      await replaceWorkspaceFiles(updates);

      return {
        files: updates.map(({ absolutePath, edits }) => ({
          absolutePath,
          editCount: edits.length,
        })),
        totalEdits: updates.reduce((total, file) => total + file.edits.length, 0),
      };
    },
    catch: (cause) =>
      cause instanceof WorkspaceEditApplyError
        ? cause
        : workspaceEditError("Workspace edit could not be applied.", cause),
  });
}

export function applyWorkspaceEdit(
  value: unknown,
  options: ApplyWorkspaceEditOptions = {},
): Promise<AppliedWorkspaceEdit> {
  return Effect.runPromise(applyWorkspaceEditEffect(value, options));
}
