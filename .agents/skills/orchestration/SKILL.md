---
name: orchestration
description: Coordinates subagents that investigate tasks, discover relevant skills and tools, and return work for integration. Use when work benefits from parallel execution, isolated contexts, or dependent stages.
---

# Orchestration

## Prepare bounded work

Delegate when a separate context or execution boundary justifies the coordination cost. Keep scope, sequencing, integration, and completion in the parent session. Before dispatch, inspect the live `subagent` tool description for available agents, models, actions, tools, job lifecycle, and runtime limits.

Give each child a goal and enough context to investigate it within explicit boundaries. Explain what evidence the parent needs to assess and integrate the result. Shape the assignment around the task and available capabilities, leaving the child room to choose its approach.

Pass relevant skills and references based on your interpretation of the task. Use tool search when available to discover capabilities, and let children find other applicable skills and tools as their investigation develops. Supplied references are starting points, not an exhaustive procedure.

Bound tool access and context to the task's scope and privacy requirements. Supply relevant facts or file references rather than the parent transcript, and gather shared evidence once unless independent investigation is the purpose. Keep children isolated from each other, routing results and new decisions through the parent. For independent reviews, provide the same evidence with distinct review scopes.

Before repository writes, follow [code-contribution](../code-contribution/SKILL.md) and prepare a dedicated worktree for each writer. A subagent `cwd` does not create a worktree.

## Schedule and integrate

Start independent jobs before waiting, and dispatch dependent work after its inputs settle. Review each child's results and evidence before integrating them. Resolve conflicts and verify the combined result in the parent session, including required repository checks.

If a job fails, retry only the failed slice rather than rerunning successful work. Adjust its brief, context, tools, model, or scope before retrying.
