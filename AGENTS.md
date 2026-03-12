# AGENTS.md

## Principles

- **Retrieval over pre-training.** When unsure, read the source — don't reason from what you already know. Code, config, and notes equally.
- **System before parts.** Before implementing, state: intended impact, components touched, assumptions. When execution reveals new dynamics, re-orient before continuing.
- Prefer reversible operations. Commit before multi-file changes.
- Cross-component behavioral changes: write a numbered step list. Mechanical refactors don't need one.

## Clarify Before Exploring

Ambiguous or open-ended requests: state interpretation and plan first.

## Safety

- High-risk ops (bulk deletes, force pushes, DB mutations, prod config): state intent, scope, and undo path — then wait for confirmation.
- Never commit secrets. If a secret appears, stop and flag it.
- Scope edits to the working tree unless told otherwise.

## Subagent Model Selection

Match model to task. `subagent()` inherits the parent model — override it. Read-heavy gathering and mechanical edits: `anthropic/claude-haiku-4-5`. Reserve the parent model for judgment, adversarial thinking, or subtle tradeoffs.
