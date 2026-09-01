import { Data, type Effect } from "effect";

export interface NoteEntry {
  readonly path: string;
  readonly size?: number;
  readonly modifiedAt?: number;
}

export interface NoteSearchResult {
  readonly path: string;
  readonly title?: string;
  readonly snippet?: string;
}

export interface ExactEdit {
  readonly oldText: string;
  readonly newText: string;
}

export interface NotesProvider {
  readonly id: "obsidian";
  readonly root: string;
  index(): Effect.Effect<string, NotesProviderError>;
  list(prefix?: string): Effect.Effect<readonly NoteEntry[], NotesProviderError>;
  read(path: string): Effect.Effect<string, NotesProviderError>;
  search(query: string): Effect.Effect<readonly NoteSearchResult[], NotesProviderError>;
  write(path: string, content: string): Effect.Effect<void, NotesProviderError>;
  edit(
    path: string,
    edits: readonly ExactEdit[],
    append?: string,
  ): Effect.Effect<void, NotesProviderError>;
  delete(path: string): Effect.Effect<void, NotesProviderError>;
  queuePath(path: string): string;
}

export class NotesProviderError extends Data.TaggedError("NotesProviderError")<{
  readonly code:
    | "invalid-path"
    | "not-found"
    | "not-a-note"
    | "path-escape"
    | "ambiguous-edit"
    | "missing-edit"
    | "io";
  readonly message: string;
  readonly cause?: unknown;
}> {}
