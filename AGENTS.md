# AGENTS.md

## Principles

- **Prefer retrieval-led reasoning over pre-training-led reasoning.** When unsure, read the source — don't reason from what you already know. This applies to code, config, and personal notes equally.
- Prefer reversible operations. Commit before multi-file changes.
- Before any code change, create a git worktree on a new branch named for the task. Do not edit directly on the main/master branch.
- Before any change touching 3+ files, write a numbered step list first.

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
