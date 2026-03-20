# AGENTS.md

## Principles

- **Prefer retrieval-led reasoning over pre-training-led reasoning.** When unsure, read the source — don't reason from what you already know. This applies to code, config, and personal notes equally.
- **Understand the system before optimizing the parts.** Before planning implementation, state: what is this change's intended impact? What other components does it touch? What assumptions does it rest on? If new information changes the picture mid-execution, stop and reorient.
- Prefer reversible operations. Commit before multi-file changes.
- Before changes that alter system behavior across multiple components, write a numbered step list. Mechanical refactors (renames, import updates) don't need one.

## Workflow

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before making any changes.

## Clarify Before Exploring

For ambiguous or open-ended requests, state your interpretation and planned approach before executing.

## Safety

- High-risk ops (bulk deletes, force pushes, DB mutations, prod config): state intent, scope, and undo path — then wait for confirmation.
- Never commit secrets. If a secret appears unexpectedly in output or context, stop and flag it — do not use it.
- Scope edits to the working tree unless told otherwise.

## Pi Capabilities

For a structured overview of pi's features, modes, extension API, session system, SDK, and all doc locations, see [`docs/pi-capability-map.md`](docs/pi-capability-map.md). The map is auto-generated from upstream docs — regenerate after version bumps with `bash scripts/generate-capability-map.sh`.

## Subagent Model Selection

Match model to task. `subagent()` inherits the parent model by default — override it. Read-heavy gathering, file summarization, and mechanical edits should use a cheap model (`anthropic/claude-haiku-4-5`). Reserve the parent model for tasks requiring judgment, adversarial thinking, or subtle tradeoff analysis.
