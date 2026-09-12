---
name: orchestration
description: Coordinate focused subagents for parallel research, implementation, review, and staged workflows. Use when work benefits from isolated child contexts or independent execution.
---

# Orchestration

Route bounded context to focused subagents. The parent owns scope, sequencing, integration, and completion.

```text
gather once → dispatch independent work → wait → synthesize → verify
```

## Guidance

- Define the goal, constraints, non-goals, and completion evidence.
- Delegate when parallel work, isolated context, or independent review can improve speed or quality. Work directly when delegation would add overhead without a useful boundary.
- Give each child one goal, a bounded scope, required evidence, and an output contract.
- Follow the `code-contribution` skill before code changes. Isolate each writer in a dedicated worktree.
- Start independent jobs before waiting. Dispatch dependent work after their inputs settle.
- Review and distill each child handoff. Do not relay child output without review.
- Resolve conflicts and run the required repository checks in the parent session.

Inspect the live `subagent` tool description before dispatch. It is the source of truth for agents, models, actions, tools, job lifecycle, and runtime limits.

## Delegation rules

- Use least privilege. Give each child only the tools and context that its task requires.
- Do not pass the parent transcript to a child. Put required facts in the brief or in referenced files.
- Do not duplicate reconnaissance unless independent review is the goal.
- Keep children isolated from each other. Route handoffs and new decisions through the parent.
- For independent review, give children the same evidence and distinct review scopes.
- Retry only the failed slice. Change its brief, context, tools, model, or scope before retrying.

A subagent `cwd` does not create a worktree. Use the `code-contribution` skill to prepare and clean worktrees. The parent remains responsible for inspecting and integrating child changes.

Do not describe ordinary subagent dispatch as a DAG run. The repository DAG runtime belongs to code-owned domain workflows.

## Boundaries

This skill owns subagent decomposition, routing, and synthesis. The `code-contribution` skill owns repository contribution workflow. Domain skills own implementation and safety policy.
