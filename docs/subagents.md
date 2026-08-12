# Subagents

The subagent extension runs child agents in the parent Pi process. Each child has an isolated context and a linked persistent session transcript.

## Execution modes

Use `subagent` when the parent must wait for the child result.

Use `subagent_start` to start a session-scoped job and continue parent work. The tool returns a volatile job ID. Use `subagent_job` to manage the job:

- `list` returns bounded metadata for retained jobs.
- `status` returns metadata for one job.
- `wait` waits for a terminal state and returns metadata.
- `result` returns the bounded retained result.
- `cancel` requests cancellation.
- `usage` returns aggregate subagent usage for the parent session.

Use the child session file when you need the complete transcript. Live job handles do not survive a restart. The extension does not retry interrupted work automatically.

## Agent definitions and trust

The default `agent_scope` is `user`. This scope includes user agents and agents from installed packages.

Set `agent_scope` to `project` to use a project agent. Pi must trust the project before the extension resolves the agent. The project scope contains project agents only.

## Resource limits

One supervisor controls admission for blocking jobs, asynchronous jobs, and direct child-runtime callers. The supervisor controls concurrency, pending runs, workspace writers, and run time.

Configure limits in the `subagent` settings block:

```json
{
  "subagent": {
    "maxConcurrentRuns": 4,
    "maxPendingRuns": 16,
    "maxRetainedJobs": 32,
    "maxResultBytes": 51200,
    "maxRunMs": 1800000,
    "cancellationGraceMs": 500
  }
}
```

The supervisor bounds pending admission. Write-capable runs serialize by canonical Git workspace. Retention eviction removes the volatile job handle but does not delete its child session transcript.

## Cancellation states

A running job changes to `cancelling` after a cancellation request. A cooperative child changes to `cancelled` after it settles. If the child does not settle before the cancellation deadline, the job changes to `interrupted`.

Parent session shutdown rejects new jobs, cancels queued jobs, and drains running jobs within the configured cancellation boundary. Before parent tree navigation, the extension settles active jobs so a late result cannot attach to the selected branch.
