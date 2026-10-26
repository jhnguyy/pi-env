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
        `Search local pi session user and assistant text, including nested sessions and alternate branches. Read-only. Returns at most ${SESSION_SEARCH_LIMIT} snippets with file paths and entry IDs, newest files first. Excludes tool-call names and arguments, tool output, thinking, and summaries. Finds mentions, not invocations. Use read_session with mode usage for recorded calls and skill-loading evidence. Use list_sessions for metadata navigation.`,
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
      "List pi sessions as compact navigation digests before selecting one for read_session. Returns session IDs, cwd, timestamp, first prompt, counts, error counts, labels, branch/compaction markers, and file paths without raw JSONL or tool output.",
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
      'Read one local Pi session by exact sessionId or path from list_sessions. Read-only. Default basic returns metadata and tool/skill count dictionaries. mode detailed adds sparse navigation and call evidence with recorded timestamps, durations, outcomes, and nested-call markers. mode usage returns only usage dictionaries and evidence. Use fields for specific checks, such as {"sessionId":"...","fields":["tools"]}. Tool, skill, and argument filters combine with AND and affect only usage evidence. Counts cover all matching records in that file, including stored alternate branches, not child session files. References are bounded by limit and output budget. Raw arguments, tool output, thinking, and full assistant prose are excluded. Error navigation returns tool names and line references, not error output. Missing timing is omitted, not estimated. Timestamps identify the containing message entry, not exact execution start times. Skill reads mean successful read calls to SKILL.md, keyed by parent directory. Skill envelopes are user text shaped like Pi\'s /skill: expansion, not proof of command invocation. Neither proves skill compliance. incompleteNestedRecords flags known gaps in retained nested calls. Use search_sessions for text mentions.',
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
