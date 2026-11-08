import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { createNotesContract, type NotesContractOptions } from "./contract";
import type { NotesProvider } from "./domain";

export function createCodingAgentNotesContract(
  source: NotesProvider | (() => NotesProvider),
  options: NotesContractOptions = {},
) {
  const contract = createNotesContract(source, options);
  return {
    ...contract,
    execute: async (...args: Parameters<typeof contract.execute>) => {
      const result = await contract.execute(...args);
      const text = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const truncated = truncateHead(text, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: truncated.truncated
              ? `${truncated.content}\n\n[Output truncated: ${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}.]`
              : truncated.content,
          },
        ],
        details: truncated.truncated ? { ...result.details, truncated: true } : result.details,
      };
    },
  };
}
