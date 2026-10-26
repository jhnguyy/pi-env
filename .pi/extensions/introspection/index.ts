import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import * as ContractTools from "../_shared/register-contract-tool";
import { registerPublicTool, renderCompactToolCall, renderTextToolResult } from "../_shared/tool-render";
import { executeReadSession, READ_OUTPUT_SCHEMA, READ_SCHEMA } from "./read";
import {
  SESSION_SEARCH_LIMIT,
  formatDigestList,
  listSessionDigests,
  searchSessionMessages,
} from "./sessions";

const LIST_SCHEMA = Type.Object({
  cwd: Type.Optional(Type.String({ description: "Only include sessions whose recorded cwd exactly matches this path. Defaults to all cwd values." })),
  query: Type.Optional(Type.String({ description: "Case-insensitive filter across cwd, session name, timestamp, and first/last user prompt." })),
  limit: Type.Optional(Type.Number({ description: "Maximum sessions to return, 1-100. Defaults to 20." })),
});

const SEARCH_SCHEMA = Type.Object({
  term: Type.String({ minLength: 1, maxLength: 200, description: "Literal word or phrase to find. Case-insensitive, not a regex." }),
  cwd: LIST_SCHEMA.properties.cwd,
});

type ListSessionsParams = { cwd?: string; query?: string; limit?: number };

function truncatedText(raw: string): { text: string; truncated: boolean } {
  const trunc = truncateHead(raw, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  let text = trunc.content;
  if (trunc.truncated) text += `\n\n[Output truncated: ${formatSize(trunc.outputBytes)} of ${formatSize(trunc.totalBytes)}.]`;
  return { text, truncated: trunc.truncated };
}

function executeListSessions(params: ListSessionsParams, signal?: AbortSignal) {
  if (signal?.aborted) {
    return { content: [{ type: "text" as const, text: "Cancelled." }], details: { count: 0, truncated: false, cancelled: true } };
  }
  const sessions = listSessionDigests({ cwd: params.cwd, query: params.query, limit: params.limit });
  const { text, truncated } = truncatedText(formatDigestList(sessions));
  return { content: [{ type: "text" as const, text }], details: { count: sessions.length, truncated, cancelled: false } };
}

export default function (pi: ExtensionAPI) {
  ContractTools.registerContractTool<{ term: string; cwd?: string }, Awaited<ReturnType<typeof searchSessionMessages>>, typeof SEARCH_SCHEMA>(pi, {
    contract: {
      name: "search_sessions",
      label: "Search Sessions",
      description:
        `Read-only search of user/assistant text mentions, not invocations. Includes nested sessions and stored branches. Returns up to ${SESSION_SEARCH_LIMIT} snippets with file paths and entry IDs, newest files first. Excludes tool calls, tool output, thinking, and summaries. Use read_session mode usage for recorded calls and skill evidence.`,
      parameters: SEARCH_SCHEMA,
      async execute(params, { signal }) {
        const result = await searchSessionMessages({ term: params.term, cwd: params.cwd, signal });
        const output = truncatedText([
          JSON.stringify({ matchCount: result.matches.length, moreMatches: result.truncated }),
          ...result.matches.map((match) => JSON.stringify(match)),
        ].join("\n"));
        return { content: [{ type: "text", text: output.text }], details: { ...result, truncated: result.truncated || output.truncated } };
      },
    },
    piOptions: {
      exposure: "deferred",
      namespace: { name: "pi-env", description: "Local analysis, session, web, and issue tools" },
      renderCall: (params, theme) => renderCompactToolCall("search_sessions", params.term, theme),
      renderResult: (result, options, theme, context) => renderTextToolResult("search_sessions", result, options, theme, context),
    },
  });

  registerPublicTool(pi, {
    name: "list_sessions",
    label: "List Sessions",
    exposure: "deferred",
    namespace: { name: "pi-env", description: "Local analysis, session, web, and issue tools" },
    description:
      "Read-only session navigation. Returns compact metadata and IDs/paths for read_session, without raw transcripts or tool output.",
    parameters: LIST_SCHEMA,
    async execute(_id, params, signal) { return executeListSessions(params, signal); },
    renderCall: (params, theme) => renderCompactToolCall("list_sessions", params.query ?? params.cwd, theme),
    renderResult: (result, options, theme, context) => renderTextToolResult("list_sessions", result, options, theme, context),
  });

  registerPublicTool(pi, {
    name: "read_session",
    label: "Read Session",
    exposure: "deferred",
    namespace: { name: "pi-env", description: "Local analysis, session, web, and issue tools" },
    description:
      'Read-only inspection of one local Pi session by exact ID or path. Filters combine with AND and affect usage only. Includes stored branches, not child files. Returns counts and bounded evidence, not raw arguments, tool output, thinking, or full assistant prose. Recorded timestamps identify messages, not execution starts. Missing timing is omitted. Known nested-call gaps are flagged. Skill envelopes do not prove command invocation. Reads and envelopes do not prove skill compliance. Use search_sessions for text mentions.',
    parameters: READ_SCHEMA,
    outputSchema: READ_OUTPUT_SCHEMA,
    async execute(_id, params, signal) { return executeReadSession(params, signal); },
    renderCall: (params, theme) => renderCompactToolCall("read_session", `${params.sessionId ?? params.path ?? ""} ${params.mode ?? "basic"}`, theme),
    renderResult: (result, options, theme, context) => renderTextToolResult("read_session", result, options, theme, context),
  });

  pi.registerCommand("sessions", {
    description: "List recent pi sessions as compact navigation digests",
    handler: async (args, ctx) => {
      const { content } = executeListSessions({ query: args.trim() || undefined, limit: 20 });
      ctx.ui.notify(content[0]?.text ?? "No matching pi sessions found.", "info");
    },
  });
}
