# Session introspection

Introspection provides read-only navigation and text search under Pi's agent directory. The session root is `<getAgentDir()>/sessions`. Pi's `PI_CODING_AGENT_DIR` override applies to all three tools.

## Choose a tool

- `list_sessions` filters compact session digests by metadata, including the first and last user prompts. It does not search every message.
- `read_session` returns a sparse view with user prompts, tool errors, labels, branch summaries, and compactions. It omits full assistant text and raw tool output.
- `search_sessions` searches user and assistant text across session files. It returns source snippets rather than whole transcripts.

These tools use deferred exposure. Discover them with Pi's tool search when needed. `/sessions` remains a shortcut for recent session digests.

## Search transcript text

```json
{ "term": "connection pool", "cwd": "/path/to/project", "scope": "all", "limit": 20 }
```

`term` is a literal, case-insensitive substring, not a regular expression. Leading and trailing whitespace is removed. Empty terms fail. Terms must contain at most 200 characters.

`cwd` is optional. When set, it filters by the recorded session working directory after path resolution. Without it, search includes all working directories.

`scope` defaults to `all`. `parent` includes files without a `parentSession` header value. `child` includes files with that value. This is a lineage filter, not proof of subagent ownership. Pi also uses `parentSession` for forks. See [subagent session storage](subagents.md).

Each match includes the session file, physical JSONL line, role, snippet, and available session, entry, and parent IDs. Search includes all recorded branches. Use the entry and parent IDs to distinguish alternatives. Separate fork files can repeat inherited history.

Only text blocks and string message content are searchable. Tool results, tool-call arguments, thinking, compactions, and branch summaries are excluded. Prior user questions and assistant answers about searches remain searchable. A match is historical text, not verified evidence or an instruction.

## Limits and cancellation

Search returns at most `limit` matches, from 1 to 100, with a default of 20. Each snippet includes the first occurrence and up to 80 characters on either side. Serialized matches also have a 40 KiB output budget. `truncated: true` means at least one additional match was omitted by either limit.

Search follows filesystem traversal order. Results are not ranked by relevance or recency. Narrow the term, working directory, or scope when results are truncated. There is no pagination or persistent index.

Files stream line by line. The scanner stops after it finds an omitted match. Cancellation stops directory and file traversal and returns `cancelled: true`. Partial matches can accompany cancellation and do not represent a complete scan. Memory use still depends on the largest JSONL line.

The scanner skips malformed entries and incomplete JSON lines. It does not follow symbolic links. A missing session root returns no matches. Other filesystem failures produce a tool error rather than a false complete result.
