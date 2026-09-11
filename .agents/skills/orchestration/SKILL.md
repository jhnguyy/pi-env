---
name: orchestration
description: Coordinate focused subagents for parallel research, implementation, review, and staged workflows. Use when work benefits from isolated child contexts or independent execution.
---

# Orchestration

Route bounded context to focused subagents. The parent owns scope, sequencing, integration, and completion.

```text
gather once → dispatch independent work → wait → synthesize → verify
```

## Method

1. Define the goal, constraints, non-goals, and completion evidence.
2. Use an available read-only agent when repository context is not already available.
3. Give each child one goal, a bounded scope, required evidence, and an output contract.
4. Follow the `git` skill before code changes. Create a dedicated branch and worktree for each writer.
5. Start all independent jobs before waiting for one. Dispatch dependent work only after its inputs settle.
6. Review and distill each child handoff. Do not relay child output without review.
7. Resolve conflicts and run the required repository checks in the parent session.

Inspect the live `subagent` tool description before dispatch. It is the source of truth for agents, models, actions, tools, job lifecycle, and runtime limits.

## Delegation rules

- Use least privilege. Give each child only the tools and context that its task requires.
- Do not pass the parent transcript to a child. Put required facts in the brief or in referenced files.
- Do not duplicate reconnaissance unless independent review is the goal.
- Keep children isolated from each other. Route handoffs and new decisions through the parent.
- For independent review, give children the same evidence and distinct review scopes.
- Retry only the failed slice. Change its brief, context, tools, model, or scope before retrying.

A subagent `cwd` does not create a worktree. Use the `git` skill to prepare and clean worktrees. The parent remains responsible for inspecting and integrating child changes.

## DAG boundary

The repository DAG runtime is an internal primitive for code-owned domain workflows. It is not a generic model-facing orchestration tool. Do not describe ordinary subagent dispatch as a DAG run.

A future skill can combine this method with a generic DAG run interface after that interface exists. Until then, use the current `subagent` actions or a domain tool that owns a fixed DAG.

## Boundaries

This skill owns subagent decomposition, routing, and synthesis. The `git` skill owns repository workflow. Domain skills own implementation and safety policy.
