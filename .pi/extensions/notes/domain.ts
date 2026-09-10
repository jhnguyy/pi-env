import { Data } from "effect";

export const MAX_NOTE_BYTES = 1_048_576;
export const MAX_NOTE_COUNT = 10_000;
export const MAX_INDEX_BYTES = 16_384;
export const MAX_INDEX_ENTRIES = 200;
export const MAX_SEARCH_QUERY_LENGTH = 1_000;
export const MAX_SEARCH_RESULTS = 100;
export const MAX_REVISION_LENGTH = 256;
export const MAX_EDIT_ITEMS = 8;
export const MAX_EDIT_TEXT_LENGTH = 8_192;
export const MAX_APPEND_LENGTH = 131_072;

export interface NoteEntry {
  readonly path: string;
  readonly revision?: string;
  readonly size?: number;
  readonly modifiedAt?: number;
}

export interface NotesIndex {
  /** Bounded provider-owned orientation and store conventions. */
  readonly text: string;
  readonly entries?: readonly NoteEntry[];
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
  readonly prefix?: string;
  readonly limit?: number;
}

export interface NotesSearchRequest {
  readonly query: string;
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

/** Every registered provider implements this storage-neutral baseline contract. */
export interface NotesProvider {
  readonly id: string;
  index(signal?: AbortSignal): Promise<NotesIndex>;
  list(request: NotesListRequest, signal?: AbortSignal): Promise<readonly NoteEntry[]>;
  read(path: string, signal?: AbortSignal): Promise<NoteDocument>;
  search(request: NotesSearchRequest, signal?: AbortSignal): Promise<readonly NoteSearchResult[]>;
  resolve?(reference: string, signal?: AbortSignal): Promise<NoteDocument>;
  write(request: NotesWriteRequest, signal?: AbortSignal): Promise<NotesMutationResult>;
  delete(request: NotesDeleteRequest, signal?: AbortSignal): Promise<NotesMutationResult>;
}

export type NotesProviderErrorCode =
  | "invalid-path"
  | "invalid-revision"
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
  | "resource-limit"
  | "io";

export class NotesProviderError extends Data.TaggedError("NotesProviderError")<{
  readonly code: NotesProviderErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}> {}
