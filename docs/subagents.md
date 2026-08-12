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

Use the child session file when you need the complete transcript. A restart restores bounded job receipts. A restart changes unfinished receipts to `interrupted`. It does not retry unfinished work.

## Agent definitions and trust

The default `agent_scope` is `user`. This scope includes user agents and agents from installed packages.

Set `agent_scope` to `project` or `both` to use a project agent. Pi must trust the project before the extension resolves a project agent. The extension keeps `user`, `package`, and `project` origins distinct. If duplicate names exist, set `agent_source` to select the exact origin. Selecting `project` also selects project scope and requires project trust.

Agent frontmatter can select a workspace policy:

```yaml
workspace: read-only
```

Valid values are:

- `read-only`: Reject write and execute capabilities.
- `serialize-write`: Serialize child runs that can write or execute in the same canonical workspace. This is the default.
- `isolated-write`: Require a linked Git worktree that differs from the parent working directory.

The tool parameter `workspace_policy` overrides agent frontmatter.

## Resource limits

The extension applies one supervisor to blocking jobs, asynchronous jobs, and direct child-runtime callers. The supervisor controls model admission, concurrency, pending runs, workspace writers, time, tokens, and cost.

Configure limits in the `subagent` settings block:

```json
{
  "subagent": {
    "allowedModels": ["openai-codex/gpt-5.4-mini"],
    "maxConcurrentRuns": 4,
    "maxPendingRuns": 16,
    "maxQueuedJobs": 16,
    "maxRetainedJobs": 32,
    "maxResultBytes": 51200,
    "maxTaskBytes": 4096,
    "maxSessionTokens": 2000000,
    "maxSessionCostUsd": 25,
    "maxRunMs": 1800000,
    "cancellationGraceMs": 500
  }
}
```

`allowedModels` is optional. If it is absent, the subagent extension does not add a model allowlist.

The queue and retained job registry are bounded. A full queue rejects a new job. Retention eviction removes the volatile job handle but does not delete its child session transcript.

## Cancellation states

A running job changes to `cancelling` after a cancellation request. A cooperative child changes to `cancelled` after it settles. If the child does not settle before the cancellation deadline, the job changes to `interrupted`.

Parent session shutdown rejects new jobs, cancels queued jobs, and drains running jobs within the configured cancellation boundary. Before parent tree navigation, the extension settles active jobs so a late receipt cannot attach to the selected branch.
