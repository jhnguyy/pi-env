import { isSupported } from "./backend-configs";

export interface ToolResultEditEvent {
  toolName: string;
  isError?: boolean;
  input?: unknown;
}

export function editedFilePathFromToolResult(event: ToolResultEditEvent): string | null {
  if ((event.toolName !== "edit" && event.toolName !== "write") || event.isError) return null;

  const input = event.input as Record<string, unknown> | null | undefined;
  if (typeof input?.path === "string") return input.path;
  if (typeof input?.file_path === "string") return input.file_path;
  return null;
}

export class PendingPostEditFiles {
  readonly #files = new Set<string>();

  constructor(private readonly supportsPath: (path: string) => boolean = isSupported) {}

  recordToolResult(event: ToolResultEditEvent): void {
    const path = editedFilePathFromToolResult(event);
    if (path && this.supportsPath(path)) this.#files.add(path);
  }

  clear(): void {
    this.#files.clear();
  }

  drain(): string[] {
    const files = [...this.#files];
    this.clear();
    return files;
  }
}
