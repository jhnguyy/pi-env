import { Data } from "effect";

export const NOTES_AREAS = ["wiki", "worklog", "decisions"] as const;
export type NotesArea = (typeof NOTES_AREAS)[number];

export const NOTES_AREA_PREFIXES: Readonly<Record<NotesArea, string>> = {
  wiki: "wiki/",
  worklog: "records/worklog/",
  decisions: "records/decisions/",
};

export interface NoteEntry {
  readonly path: string;
  readonly revision?: string;
  readonly size?: number;
  readonly modifiedAt?: number;
}

export interface NoteDocument extends NoteEntry {
  readonly revision: string;
  readonly content: string;
}

export interface NoteSearchResult extends NoteEntry {
  readonly title?: string;
  readonly snippet?: string;
  readonly score?: number;
}

export interface ExactEdit {
  readonly oldText: string;
  readonly newText: string;
}

export interface NotesListRequest {
  readonly area?: NotesArea;
  readonly prefix?: string;
}

export interface NotesSearchRequest {
  readonly query: string;
  readonly areas?: readonly NotesArea[];
  readonly limit?: number;
}

export interface NotesWriteRequest {
  readonly path: string;
  readonly content: string;
  /** null requires creation. A string requires the current revision to match. */
  readonly expectedRevision: string | null;
}

export interface NotesDeleteRequest {
  readonly path: string;
  readonly expectedRevision: string;
}

export interface NotesMutationResult {
  readonly path: string;
  readonly revision?: string;
}

/** Every registered provider implements this complete baseline contract. */
export interface NotesProvider {
  readonly id: string;
  list(request: NotesListRequest, signal?: AbortSignal): Promise<readonly NoteEntry[]>;
  read(path: string, signal?: AbortSignal): Promise<NoteDocument>;
  search(request: NotesSearchRequest, signal?: AbortSignal): Promise<readonly NoteSearchResult[]>;
  resolve(reference: string, signal?: AbortSignal): Promise<NoteDocument>;
  write(request: NotesWriteRequest, signal?: AbortSignal): Promise<NotesMutationResult>;
  delete(request: NotesDeleteRequest, signal?: AbortSignal): Promise<NotesMutationResult>;
}

export class NotesProviderError extends Data.TaggedError("NotesProviderError")<{
  readonly code:
    | "invalid-path"
    | "not-found"
    | "not-a-note"
    | "path-escape"
    | "ambiguous-edit"
    | "missing-edit"
    | "conflict"
    | "unsupported-reference"
    | "invalid-provider"
    | "duplicate-provider"
    | "provider-unavailable"
    | "io";
  readonly message: string;
  readonly cause?: unknown;
}> {}
