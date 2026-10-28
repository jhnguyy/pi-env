---
name: orchestration
description: Coordinates focused subagents for research, implementation, and review. Use when work benefits from parallel execution, isolated contexts, or dependent stages.
---

# Orchestration

## Prepare bounded work

Delegate when a separate context or execution boundary justifies the coordination cost. Keep scope, sequencing, integration, and completion in the parent session.

Before dispatch, inspect the live `subagent` tool description for its agents, models, actions, tools, job lifecycle, and runtime limits.

Give each child one goal, explicit scope and non-goals, required evidence, and a return format suited to integration. Gather shared evidence once unless independent investigation is the purpose.

- Grant only the tools and context needed for that task.
- Supply relevant facts or file references, not the parent transcript.
- Keep children isolated from each other. Route results and new decisions through the parent.
- For independent reviews, provide the same evidence and distinct review scopes.
- Before repository writes, follow [code-contribution](../code-contribution/SKILL.md) and prepare a dedicated worktree for each writer. A subagent `cwd` does not create a worktree.

## Schedule and integrate

Start independent jobs before waiting. Dispatch dependent work only after its inputs settle.

Review each child's results and evidence before integrating them. Resolve conflicts and verify the combined result in the parent session, including required repository checks.

Retry only the failed slice. Adjust its brief, context, tools, model, or scope before retrying rather than rerunning successful work.

Ordinary subagent dispatch is not a DAG run. The repository DAG runtime serves code-owned domain workflows.
