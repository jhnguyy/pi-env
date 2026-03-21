# AGENTS.md

## Workflow

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before making any changes.

## Pi Capabilities

For a structured overview of pi's features, modes, extension API, session system, SDK, and all doc locations, see [`docs/pi-capability-map.md`](docs/pi-capability-map.md). The map is auto-generated from upstream docs — regenerate after version bumps with `bash scripts/generate-capability-map.sh`.

## Subagent Model Selection

Match model to task. `subagent()` inherits the parent model by default — override it. Read-heavy gathering, file summarization, and mechanical edits should use a cheap model (`anthropic/claude-haiku-4-5`). Reserve the parent model for tasks requiring judgment, adversarial thinking, or subtle tradeoff analysis.
