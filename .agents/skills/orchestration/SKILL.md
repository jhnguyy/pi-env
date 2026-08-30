---
name: orchestration
description: Subagent spawning, scoping, and context gathering. Use when decomposing tasks into scoped subagent work, gathering project context before implementation, or coordinating multi-step workflows across subagents.
---

# Orchestration

Use the smallest execution mode that preserves isolation, progress, and cleanup. Treat live tool descriptions as the source for invocation syntax, available models, limits, and lifecycle behavior.

## Route the Work

| Need | Preferred mechanism |
|---|---|
| One bounded task or context question | Synchronous `subagent` |
| Independent work while the parent continues | Asynchronous subagent job |
| Multi-agent work with branches, worktrees, or shared artifacts | `orch`, when available |
| One long-running or interactive process | `tmux`, when available |
| Genuine design disagreement | Scoped agents on a shared message channel |

If a deferred mechanism is not active, search for it before use. If `orch`, `tmux`, or message-bus tools are unavailable, use the subagent runtime.

## Plan and Dispatch

1. Define the goal, output contract, scope, and completion signal.
2. Gather only the context needed to divide the work.
3. Give each worker a distinct responsibility and the least privilege it needs.
4. Start independent workers before waiting for any result.
5. Wait on completion events. Do not poll process output for completion.
6. Synthesize worker results before starting dependent work.
7. Keep integration and verification in the parent.

Use sequential dispatch only when one result defines the next task. Do not create workers for work that the parent can complete in one bounded step.

## Scope Workers

- Lead with the task goal and the required output. Ask for findings and changes, not reasoning transcripts.
- Use an agent definition when it already owns the correct model, tools, and system prompt. Otherwise pass an explicit model and tool list.
- Select models from the live subagent tool description or current model settings. Use full provider/model identifiers. Do not rely on copied model inventories.
- Give read-only workers read tools. Give write tools only to workers that must change files.
- Pass an absolute `cwd` when a worker must operate in a specific worktree.
- Use `--no-skills` for clean context and `--no-extensions` when extension hooks can cause permission gates, if the execution mechanism supports those controls.
- Put shared briefs or large results in files. Use message channels for readiness, completion, and coordination signals.

For nontrivial implementation work, use a read-only workspace initializer or scout when available. Request only the stack, exact validation commands, relevant files, and constraining conventions. Distill that result before dispatching builders.

## Coordinate and Recover

Use event-driven waits for asynchronous jobs and orchestrated workers. Treat terminal output as diagnostic data, not a completion signal.

If a worker stalls or fails:

1. Inspect the failed worker only.
2. Check for a permission gate, invalid working directory, missing tool, or incorrect completion channel.
3. Change the prompt, scope, tool access, or inputs before retrying.
4. Restart only the failed worker with a distinct name when the mechanism requires unique names.

Do not use `sleep` loops to check completion. Do not repeat an unchanged request after a timeout or failure.

## Multi-Agent Dialogue

Use dialogue only when agents must compare evidence or resolve a real design uncertainty. Give agents the same source material and different evidence scopes. Keep them on one disputed topic. If two exchanges do not change either position, present both positions to the user.

## Cleanup

The parent must finish every orchestrated run with the active mechanism's cleanup operation. Confirm that workers stopped, temporary resources were removed, and intended branches or artifacts were preserved. If the session ends early, clean up the run in the next session.

## Boundaries

This skill owns invocation choice, worker scope, coordination, and cleanup. Domain methods, safety policy, testing policy, Git policy, and handoff content belong to their authoritative skills or repository guidance.
