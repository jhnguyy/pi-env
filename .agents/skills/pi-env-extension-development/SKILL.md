---
name: pi-env-extension-development
description: Develop or modify Pi extensions under .pi/extensions/ while following repository extension, cross-host, and semantic-readiness workflows.
---

# Pi env extension development

1. Load `docs/conventions/extensions.md` and the changed extension package (`.pi/extensions/<name>/package.json`, entrypoint, nearby tests).
2. Probe `dev-tools` semantic readiness first. If status/probe is degraded or unavailable, record the exact failed action and fallback reason before bounded text search.
3. For changes that add or expose a tool, use definitions and references for `ToolContract`, `registerCrossHostTool`, and `ToolCapability`. Then inspect one current cross-host example. Prefer `jit-catch` or `dev-tools/closeout`.
4. Use `registerCrossHostTool` for a reusable tool that needs Pi and AgentTool exposure. For a run-scoped or custom-lifecycle tool, keep a Pi-only or low-level path and record the reason beside its registration.
5. Identify exposure requirements before editing: Pi tool surface, AgentTool registration, PTC eligibility/blocking, and subagent availability.
6. Search `.pi/extensions/_shared/` and the local extension for existing execution boundaries, parsers, policies, result helpers, and lifecycle helpers before adding new ones.
7. Load `.agents/skills/effect-typescript/SKILL.md` when Effect is present or proposed.
8. Before implementation, record capability classification, working-directory behavior, cancellation, progress, and the public test boundary.
9. Keep durable architecture and policy in repository docs. Link to repository authorities instead of copying them into notes or code comments.
10. Validate with deterministic checks relevant to the change: skill validation when editing skills, targeted extension tests, and repo diff review.
