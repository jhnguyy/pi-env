import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { PiEvent, registerAgentTools, ToolCapability } from "../_shared/agent-tools";
import {
  DEFAULT_SESSION_DIR,
  assertUnderSessionDir,
  formatDigestList,
  formatSessionView,
  inspectLines,
  listSessionDigests,
  readSessionFile,
} from "./sessions";

const LIST_SCHEMA = Type.Object({
  cwd: Type.Optional(Type.String({ description: "Only include sessions whose recorded cwd exactly matches this path. Defaults to all cwd values." })),
  query: Type.Optional(Type.String({ description: "Case-insensitive filter across cwd, session name, timestamp, and first/last user prompt." })),
  limit: Type.Optional(Type.Number({ description: "Maximum sessions to return, 1-100. Defaults to 20." })),
});

const READ_SCHEMA = Type.Object({
  path: Type.String({ description: `Absolute path to a session .jsonl file under ${DEFAULT_SESSION_DIR}/.` }),
});

type ListSessionsParams = { cwd?: string; query?: string; limit?: number };
type ReadSessionParams = { path: string };

type ToolTextResult<TDetails extends Record<string, unknown>> = {
  content: Array<{ type: "text"; text: string }>;
  details: TDetails;
};

function truncatedText(raw: string): { text: string; truncated: boolean } {
  const trunc = truncateHead(raw, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  let text = trunc.content;
  if (trunc.truncated) {
    text += `\n\n[Output truncated: ${formatSize(trunc.outputBytes)} of ${formatSize(trunc.totalBytes)}.]`;
  }
  return { text, truncated: trunc.truncated };
}

function readSessionView(path: string) {
  const file = assertUnderSessionDir(path);
  const { lines, bytes } = readSessionFile(file);
  return inspectLines(lines, file, bytes);
}

function executeListSessions(
  params: ListSessionsParams,
  signal?: AbortSignal,
): ToolTextResult<{ count: number; truncated: boolean; cancelled: boolean }> {
  if (signal?.aborted) {
    return { content: [{ type: "text", text: "Cancelled." }], details: { count: 0, truncated: false, cancelled: true } };
  }
  const sessions = listSessionDigests({ cwd: params.cwd, query: params.query, limit: params.limit });
  const { text, truncated } = truncatedText(formatDigestList(sessions));
  return {
    content: [{ type: "text", text }],
    details: { count: sessions.length, truncated, cancelled: false },
  };
}

function executeReadSession(
  params: ReadSessionParams,
  signal?: AbortSignal,
): ToolTextResult<{
  file: string;
  cwd: string;
  timestamp: string;
  userTurns: number;
  toolErrors: number;
  truncated: boolean;
  cancelled: boolean;
}> {
  if (signal?.aborted) {
    return {
      content: [{ type: "text", text: "Cancelled." }],
      details: { file: "", cwd: "", timestamp: "", userTurns: 0, toolErrors: 0, truncated: false, cancelled: true },
    };
  }
  const view = readSessionView(params.path);
  const { text, truncated } = truncatedText(formatSessionView(view));
  return {
    content: [{ type: "text", text }],
    details: {
      file: view.file,
      cwd: view.cwd ?? "",
      timestamp: view.timestamp,
      userTurns: view.userTurns,
      toolErrors: view.toolErrors,
      truncated,
      cancelled: false,
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "list_sessions",
    label: "List Sessions",
    description:
      "List pi sessions as compact navigation digests before selecting one for read_session. Returns cwd, timestamp, first prompt, counts, error counts, labels, branch/compaction markers, and file paths without raw JSONL or tool output.",
    parameters: LIST_SCHEMA,
    async execute(_id, params, signal) {
      return executeListSessions(params, signal);
    },
  });

  pi.registerTool({
    name: "read_session",
    label: "Read Session",
    description:
      "Read a session path selected with list_sessions as a sparse navigation view. Default output includes metadata, user prompts, tool error summaries, labels, branch summaries, and compactions; it excludes raw tool outputs and full assistant narrative.",
    parameters: READ_SCHEMA,
    async execute(_id, params, signal) {
      return executeReadSession(params, signal);
    },
  });

  pi.registerCommand("sessions", {
    description: "List recent pi sessions as compact navigation digests",
    handler: async (args, ctx) => {
      const query = args.trim() || undefined;
      const { content } = executeListSessions({ query, limit: 20 });
      ctx.ui.notify(content[0]?.text ?? "No matching pi sessions found.", "info");
    },
  });

  pi.on(PiEvent.SessionStart, () => {
    const listTool: AgentTool<any, any> = {
      name: "list_sessions",
      label: "List Sessions",
      description: "List pi sessions as compact navigation digests. Safe, read-only, no raw tool output.",
      parameters: LIST_SCHEMA,
      execute: async (_id, params, signal) => executeListSessions(params as ListSessionsParams, signal),
    };

    const readTool: AgentTool<any, any> = {
      name: "read_session",
      label: "Read Session",
      description: "Read one pi session as sparse metadata, user prompts, tool errors, labels, branch summaries, and compactions.",
      parameters: READ_SCHEMA,
      execute: async (_id, params, signal) => executeReadSession(params as ReadSessionParams, signal),
    };

    registerAgentTools(pi, { tool: listTool, capabilities: [ToolCapability.Read] });
    registerAgentTools(pi, { tool: readTool, capabilities: [ToolCapability.Read] });
  });
}
