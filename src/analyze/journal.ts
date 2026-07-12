import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import {
  ANALYZE_DIAGNOSTIC_VERSION,
  AnalyzeDiagnosticEventType,
  AnalyzeTerminationReason,
  makeDiagnosticEvent,
  type AnalysisDiagnosticEvent,
  type DiagnosticEventSink,
} from "./diagnostics.js";

export const JOURNAL_FILE_NAME = "current.ndjson" as const;

export interface AnalysisJournalOptions {
  readonly directory: string;
  readonly maxLineBytes?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFiles?: number;
  readonly maxAgeMs?: number;
  readonly flushEveryEvents?: number;
  readonly onError?: (error: Error) => void;
}

interface NormalizedJournalOptions {
  readonly directory: string;
  readonly maxLineBytes: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFiles: number;
  readonly maxAgeMs: number;
  readonly flushEveryEvents: number;
  readonly onError?: (error: Error) => void;
}

interface JournalFile {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

const DEFAULT_OPTIONS = {
  maxLineBytes: 8 * 1024,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxFiles: 8,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  flushEveryEvents: 8,
} as const;

function normalizeOptions(options: AnalysisJournalOptions): NormalizedJournalOptions {
  const maxLineBytes = Math.max(256, options.maxLineBytes ?? DEFAULT_OPTIONS.maxLineBytes);
  const maxFileBytes = Math.max(maxLineBytes, options.maxFileBytes ?? DEFAULT_OPTIONS.maxFileBytes);
  const maxTotalBytes = Math.max(
    maxFileBytes,
    options.maxTotalBytes ?? DEFAULT_OPTIONS.maxTotalBytes,
  );
  return {
    directory: options.directory,
    maxLineBytes,
    maxFileBytes,
    maxTotalBytes,
    maxFiles: Math.max(1, options.maxFiles ?? DEFAULT_OPTIONS.maxFiles),
    maxAgeMs: Math.max(0, options.maxAgeMs ?? DEFAULT_OPTIONS.maxAgeMs),
    flushEveryEvents: Math.max(1, options.flushEveryEvents ?? DEFAULT_OPTIONS.flushEveryEvents),
    onError: options.onError,
  };
}

function isJournalFile(name: string): boolean {
  return name === JOURNAL_FILE_NAME || (name.startsWith("journal-") && name.endsWith(".ndjson"));
}

async function listJournalFiles(directory: string): Promise<JournalFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: JournalFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isJournalFile(entry.name)) continue;
    const path = join(directory, entry.name);
    const metadata = await stat(path);
    files.push({ name: entry.name, path, size: metadata.size, mtimeMs: metadata.mtimeMs });
  }
  return files.sort(
    (left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name),
  );
}

function encodeEvent(event: AnalysisDiagnosticEvent, maxLineBytes: number): Buffer {
  const encoded = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
  if (encoded.byteLength <= maxLineBytes) return encoded;
  const fallback = makeDiagnosticEvent(
    event.runId,
    event.timestampMs,
    AnalyzeDiagnosticEventType.Failure,
    { termination_reason: AnalyzeTerminationReason.OutputLimit },
  );
  const bounded = Buffer.from(`${JSON.stringify(fallback)}\n`, "utf8");
  return bounded.byteLength <= maxLineBytes ? bounded : Buffer.from("", "utf8");
}

export class AnalysisJournal {
  readonly #options: NormalizedJournalOptions;
  #handle: Awaited<ReturnType<typeof open>> | undefined;
  #currentBytes = 0;
  #eventsSinceFlush = 0;
  #disabled = false;
  #reportedError = false;
  #pending: Promise<void> = Promise.resolve();

  private constructor(options: NormalizedJournalOptions) {
    this.#options = options;
  }

  static async open(options: AnalysisJournalOptions): Promise<AnalysisJournal> {
    const journal = new AnalysisJournal(normalizeOptions(options));
    await journal.#initialize();
    return journal;
  }

  get disabled(): boolean {
    return this.#disabled;
  }

  append(event: AnalysisDiagnosticEvent): Promise<void> {
    this.#pending = this.#pending
      .then(() => this.#append(event))
      .catch((cause: unknown) => this.#disable(cause));
    return this.#pending;
  }

  async close(): Promise<void> {
    await this.#pending;
    const handle = this.#handle;
    this.#handle = undefined;
    if (handle === undefined) return;
    try {
      await handle.sync();
      await handle.close();
    } catch (cause) {
      await this.#disable(cause);
    }
  }

  async #initialize(): Promise<void> {
    try {
      await mkdir(this.#options.directory, { recursive: true, mode: 0o700 });
      await this.#prune(Date.now());
      const currentPath = join(this.#options.directory, JOURNAL_FILE_NAME);
      this.#handle = await open(currentPath, "a", 0o600);
      this.#currentBytes = (await this.#handle.stat()).size;
      if (this.#currentBytes >= this.#options.maxFileBytes) await this.#rotate();
    } catch (cause) {
      await this.#disable(cause);
    }
  }

  async #append(event: AnalysisDiagnosticEvent): Promise<void> {
    if (this.#disabled || this.#handle === undefined) return;
    const line = encodeEvent(event, this.#options.maxLineBytes);
    if (line.byteLength === 0) return;
    if (this.#currentBytes + line.byteLength > this.#options.maxFileBytes) await this.#rotate();
    await this.#makeTotalCapacity(line.byteLength);
    if (this.#disabled || this.#handle === undefined) return;
    await this.#handle.write(line);
    this.#currentBytes += line.byteLength;
    this.#eventsSinceFlush += 1;
    if (event.terminal || this.#eventsSinceFlush >= this.#options.flushEveryEvents) {
      await this.#handle.sync();
      this.#eventsSinceFlush = 0;
    }
  }

  async #rotate(): Promise<void> {
    const handle = this.#handle;
    if (handle !== undefined) {
      await handle.sync();
      await handle.close();
      this.#handle = undefined;
    }
    const currentPath = join(this.#options.directory, JOURNAL_FILE_NAME);
    try {
      const metadata = await stat(currentPath);
      if (metadata.size > 0) {
        await rename(
          currentPath,
          join(this.#options.directory, `journal-${Date.now()}-${randomUUID().slice(0, 8)}.ndjson`),
        );
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    await this.#prune(Date.now());
    this.#handle = await open(currentPath, "a", 0o600);
    this.#currentBytes = 0;
    this.#eventsSinceFlush = 0;
  }

  async #makeTotalCapacity(incomingBytes: number): Promise<void> {
    const files = await listJournalFiles(this.#options.directory);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (total + incomingBytes <= this.#options.maxTotalBytes) break;
      if (file.name === JOURNAL_FILE_NAME) continue;
      await rm(file.path, { force: true });
      total -= file.size;
    }
    if (total + incomingBytes > this.#options.maxTotalBytes && this.#currentBytes > 0) {
      await this.#rotate();
      await this.#makeTotalCapacity(incomingBytes);
    }
  }

  async #prune(now: number): Promise<void> {
    let files = await listJournalFiles(this.#options.directory);
    for (const file of files) {
      if (file.name === JOURNAL_FILE_NAME) continue;
      if (now - file.mtimeMs > this.#options.maxAgeMs) await rm(file.path, { force: true });
    }
    files = await listJournalFiles(this.#options.directory);
    const rotated = files.filter((file) => file.name !== JOURNAL_FILE_NAME);
    while (rotated.length > Math.max(0, this.#options.maxFiles - 1)) {
      const oldest = rotated.shift();
      if (oldest !== undefined) await rm(oldest.path, { force: true });
    }
    files = await listJournalFiles(this.#options.directory);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (total <= this.#options.maxTotalBytes) break;
      if (file.name === JOURNAL_FILE_NAME) continue;
      await rm(file.path, { force: true });
      total -= file.size;
    }
  }

  async #disable(cause: unknown): Promise<void> {
    if (this.#disabled && this.#reportedError) return;
    this.#disabled = true;
    const handle = this.#handle;
    this.#handle = undefined;
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The journal is already disabled; never retry a failed close.
      }
    }
    if (!this.#reportedError) {
      this.#reportedError = true;
      this.#options.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }
}

export function journalSink(journal: AnalysisJournal): DiagnosticEventSink {
  return (event) => Effect.promise(() => journal.append(event));
}

function parseJournalLine(line: string): AnalysisDiagnosticEvent | undefined {
  if (line.length === 0) return undefined;
  try {
    const value = JSON.parse(line) as Partial<AnalysisDiagnosticEvent>;
    if (value.version !== ANALYZE_DIAGNOSTIC_VERSION) return undefined;
    if (typeof value.runId !== "string" || typeof value.timestampMs !== "number") {
      return undefined;
    }
    if (
      !Object.values(AnalyzeDiagnosticEventType).includes(value.type as AnalyzeDiagnosticEventType)
    ) {
      return undefined;
    }
    if (
      typeof value.attributes !== "object" ||
      value.attributes === null ||
      typeof value.terminal !== "boolean"
    ) {
      return undefined;
    }
    const sanitized = makeDiagnosticEvent(
      value.runId,
      value.timestampMs,
      value.type as AnalyzeDiagnosticEventType,
      value.attributes as Record<string, unknown>,
    );
    return sanitized.terminal === value.terminal ? sanitized : undefined;
  } catch {
    // A crash can leave one partial trailing line; retain all complete records.
    return undefined;
  }
}

async function readJournalFile(file: JournalFile): Promise<AnalysisDiagnosticEvent[]> {
  const handle = await open(file.path, "r");
  try {
    const text = await handle.readFile({ encoding: "utf8" });
    return text
      .split("\n")
      .map(parseJournalLine)
      .filter((event): event is AnalysisDiagnosticEvent => event !== undefined);
  } finally {
    await handle.close();
  }
}

export async function readJournalEvents(directory: string): Promise<AnalysisDiagnosticEvent[]> {
  let files: JournalFile[];
  try {
    files = await listJournalFiles(directory);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  const events: AnalysisDiagnosticEvent[] = [];
  // analyze: allow-sequential
  for (const file of files) events.push(...(await readJournalFile(file)));
  return events.sort((left, right) => left.timestampMs - right.timestampMs);
}
