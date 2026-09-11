# Subagents

The subagent extension runs child agents in the parent Pi process. Each child has an isolated context and a linked persistent session transcript.

By default, the extension stores each child of a persistent parent below `_children/<parent-session-id>/` in the parent's session directory. A child of an in-memory parent uses Pi's native default session directory. Native Pi session discovery does not recurse into the nested child directory. This keeps the native resume picker focused on parent sessions. Recursive pi-env introspection can still list and read child transcripts. Use `pi --session <path>` to resume a child by its exact path.

## Actions

The `subagent` tool uses one `action` parameter for blocking runs and background job management.

Use `action: "run"` when the parent must wait for the child result.

Use `action: "start"` to start a session-scoped job and continue parent work. The tool returns a volatile job ID. Use these actions to manage the job:

- `list` returns bounded metadata for retained jobs.
- `status` returns metadata for one job.
- `wait` waits for a terminal state. A successfully completed job returns its bounded retained final answer directly. Other terminal states return status metadata.
- `result` returns only the bounded retained final answer for a completed job. Job, usage, session, and truncation metadata remain available in tool details and the TUI.
- `cancel` requests cancellation.
- `usage` returns aggregate subagent usage for the parent session.

Use the child session file when you need the complete transcript. Live job handles do not survive a restart. The extension does not retry interrupted work automatically.

Collapsed TUI views omit the full delegated task and child output. Expanded views show the task and available child output. Tool call summaries never show an inline system prompt. Each active background child has one brief line in the lower status area immediately above the built-in footer. The line disappears when the child reaches a terminal state.

## Agent definitions and trust

The default `agent_scope` is `user`. This scope includes user agents and agents from installed packages.

Set `agent_scope` to `project` to use a project agent. Pi must trust the project before the extension resolves the agent. The project scope contains project agents only.

## Resource limits

One supervisor controls admission for blocking jobs, asynchronous jobs, and direct child-runtime callers. The supervisor controls concurrency, pending runs, workspace writers, and run time.

Public `run` and `start` actions do not have a turn-count limit. The configured run-time limit still applies.

Configure limits in the `subagent` settings block:

```json
{
  "subagent": {
    "maxConcurrentRuns": 4,
    "maxPendingRuns": 16,
    "maxRetainedJobs": 32,
    "maxResultBytes": 51200,
    "maxRunMs": 1800000,
    "cancellationGraceMs": 500,
    "sessionStorage": "nested"
  }
}
```

The supervisor bounds pending admission. Write-capable runs serialize by canonical Git workspace. Retention eviction removes the volatile job handle but does not delete its child session transcript.

Set `sessionStorage` to `"sibling"` only when native Pi must discover child transcripts beside their parent. The default is `"nested"`.

## Cancellation states

A running job changes to `cancelling` after a cancellation request. A cooperative child changes to `cancelled` after it settles. If the child does not settle before the cancellation deadline, the job changes to `interrupted`.

Parent session shutdown rejects new jobs, cancels queued jobs, and drains running jobs within the configured cancellation boundary. Before parent tree navigation, the extension settles active jobs so a late result cannot attach to the selected branch.
