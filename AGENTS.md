# AGENTS.md

## Principles

- **Prefer retrieval-led reasoning over pre-training-led reasoning.** When unsure, read the source — don't reason from what you already know. This applies to code, config, and personal notes equally.
- Prefer reversible operations. Commit before multi-file changes.
- Before any code change, create a git worktree on a new branch named for the task. Do not edit directly on the main/master branch.
- Before any change touching 3+ files, write a numbered step list first.
- When a branch merges, delete any handoff that tracked that work. Handoffs are launch
  pads, not trackers — tasks.md is the source of truth for open work.
- **Gather context through scouts.** The orchestrator's primary capability is routing: dispatch cheap read-only scouts to extract file paths and distilled summaries, then synthesize that context into focused worker briefs. Scouts handle source reading; orchestrators handle context routing. This preserves your context budget for orchestration logic, not source files.

## Clarify Before Exploring

Before running exploratory commands to resolve missing context, **ask the user first**. State what's missing and why. Only explore autonomously when the answer is clearly self-contained (e.g., a file that should exist, a running service).

## Safety

- High-risk ops (bulk deletes, force pushes, DB mutations, prod config): state intent, scope, and undo path — then wait for confirmation.
- Never commit secrets. If a secret appears unexpectedly in output or context, stop and flag it — do not use it.
- Scope edits to the working tree unless told otherwise.

## Session Tasks

At the start of each user request, add tasks with `/todo <description>` before beginning work.
Mark complete with `/todo done <n>` as you finish each one.
This gives the user a live view of progress within the session.

## Attribution

Workers tag all commits with `Agent-Id` trailers in the format `Agent-Id: <label>/<session>`. Orchestrators can query these trailers to audit which agent made which changes:

```bash
git log --format="%s%n%b" origin/main..HEAD | grep "Agent-Id:"
```

Workers spawned via `orch spawn` receive `PI_AGENT_ID` and `PI_BUS_SESSION` automatically. The commit-msg hook reads `PI_AGENT_ID` for trailer injection.
