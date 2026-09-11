---
name: orchestration
description: Coordinate focused subagents for parallel research, implementation, review, and staged workflows. Use when work benefits from isolated child contexts or independent execution.
---

# Orchestration

## Goal

Route bounded context to focused subagents. Let each child complete one owned task. Synthesize child results in the parent session.

```text
gather context → dispatch independent work → wait → synthesize → verify
```

The parent session owns scope, sequencing, integration, and completion. Subagents do not coordinate with each other.

## Select the execution path

| Need | Path |
|---|---|
| One focused result before other work can continue | `subagent` with `action: "run"` |
| Two or more independent tasks | Start all jobs, then wait for each job |
| Read-only repository orientation | Use an available `scout`, `gatherer`, or `workspace-init` agent |
| Parallel code changes | Create one Git worktree per writer, then pass each worktree as `cwd` |
| Work derived from an earlier result | Wait, distill the result, then dispatch the next stage |
| Fixed domain DAG, such as PR review | Use the domain tool that owns that DAG |

Inspect the live `subagent` tool description before dispatch. It is the source of truth for available agents, models, actions, and tools. Always pass an explicit model when the selected agent does not define one.

## Workflow

1. **Establish scope.** Define the goal, completion evidence, constraints, and non-goals.
2. **Gather once.** Use a read-only child when repository context is not already available.
3. **Form briefs.** Give each child one goal, its allowed scope, required evidence, and expected output.
4. **Isolate writers.** Follow the `git` skill before code changes. Create a dedicated branch and worktree for each writer.
5. **Dispatch in parallel.** Start all independent jobs before waiting for one.
6. **Wait without polling.** Use `action: "wait"`. Do not repeatedly call `status`.
7. **Distill results.** Extract decisions, evidence, changed files, validation, and unresolved problems. Do not relay child output without review.
8. **Integrate and verify.** The parent owns conflict resolution, repository checks, final review, and cleanup.

## Scoping

Use least privilege:

- Prefer a named read-only agent for reconnaissance.
- For an inline child, provide only the tools required by the brief.
- Use an existing absolute directory for `cwd`.
- Set `agent_scope: "project"` only when the project is trusted and the project agent is required.
- Do not give a child the parent transcript. Put required facts in the brief or in referenced files.
- Do not ask multiple children to inspect the same scope unless independent review is the goal.

A subagent `cwd` does not create a worktree. Write-capable runs in one canonical Git workspace serialize. Use separate worktrees when parallel writers are necessary.

## Dispatch pattern

```text
start scout-a
start scout-b
wait scout-a
wait scout-b
synthesize
```

Use sequential dispatch only when one result determines the next task:

```text
run scout
→ distill findings
→ start worker-a and worker-b
→ wait for both
→ run focused reviewer
→ verify in parent
```

Subagent job IDs are session-scoped and do not survive a restart. Child session transcripts persist. Read a transcript only when the bounded result is insufficient or a failure needs diagnosis.

## Handoffs

A child final answer is its handoff. Require only information that the parent needs:

- result or files changed;
- commands and checks run;
- errors or incomplete work;
- deviations that affect the goal.

For large shared context, write one bounded brief and pass its path to each child. Keep implementation details in the owning repository or worktree.

## Failure handling

- Cancel jobs that are no longer useful.
- If waiting is interrupted, the job can continue. Wait again or retrieve the result later.
- Do not assume an interrupted or failed job retries automatically.
- Before retrying, change the brief, context, tools, model, or scope.
- Retry only the failed slice.
- Treat partial child changes as untrusted until the parent inspects and verifies them.

## Multi-agent review

For independent judgment, give children the same evidence and different, explicit review scopes. Keep them isolated. The parent compares findings and resolves disagreements.

If repeated exchanges do not resolve a disagreement, bring the decision to the user. Persistent disagreement often depends on values or product intent.

## DAG boundary

The repository DAG runtime is an internal execution primitive for code-owned domain workflows. It is not a generic model-facing orchestration tool. Do not describe ordinary subagent dispatch as a DAG run.

A future skill can combine this orchestration method with a generic DAG run interface after that interface exists. Until then, use the current `subagent` actions or a domain tool that already owns a fixed DAG.

## Boundaries

This skill owns subagent routing, staging, and result synthesis. The `git` skill owns branches, worktrees, commits, pull requests, and cleanup. Domain skills own implementation and safety policy.
