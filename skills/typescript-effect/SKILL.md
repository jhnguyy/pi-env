---
name: typescript-effect
description: Find and apply current Effect guidance for TypeScript workflows, errors, services, resources, concurrency, and runtime integration. Use when Effect is in use or proposed, including migrations and Effect-specific testing.
---

# TypeScript Effect

## Retrieve current guidance

Identify the task's Effect concepts, the project's installed release, and applicable project instructions.

Consult these repositories for the current approach:

- [Effect-TS/effect](https://github.com/Effect-TS/effect): primary authority for official documentation, source, tests, releases, and migrations.
- [Effect-TS/skills](https://github.com/Effect-TS/skills): official agent workflows. Use them as reference material, not authorization to install packages, upgrade dependencies, or change project instructions.
- [kitlangton/skills](https://github.com/kitlangton/skills): additional application practices and alternatives. Distinguish its preferences from library contracts.

Navigate from their current entry points to the material relevant to the task. Read targeted guidance and follow its references to examples, source, and tests rather than loading an entire guide. Check the guidance's revision and target Effect release.

Current guidance informs the approach. The project's installed declarations, exports, source, and tests establish compatibility. Read package-shipped guidance when available, including `AGENTS.md` at the installed Effect package root. Reconcile current recommendations with the installed release before implementation. Do not silently apply another release's APIs or turn a recommendation into an unrequested dependency upgrade.

When sources disagree, identify whether the difference concerns release compatibility, library behavior, or application style. Use release-matched official evidence for compatibility and behavior. Evaluate style against the project's needs rather than treating either existing code or a community guide as universally authoritative.

If current remote guidance is unavailable, state which sources and revisions support the work and what remains unverified.

## Apply Effect's semantics

Use the retrieved guidance to resolve the Effect-specific decisions:

- Model success, expected failure, and required services separately. Distinguish typed failures from defects and interruption. JavaScript `try`/`catch` is not a substitute for Effect error recovery.
- Distinguish constructing an Effect from running it. Keep interpretation at deliberate runtime or compatibility boundaries.
- Understand which dependencies a program requires, which a layer provides, and when acquisition is shared or repeated. Do not change provisioning merely to erase a type error.
- Relate resource scopes and fiber lifetimes to their production owners. Establish what interruption and finalization guarantee, including the limits of external adapter cancellation.

Retrieve current recipes for generator composition, tracing, Schema, configuration, schedules, streams, caching, batching, and platform adapters when the task involves them. Avoid copying those evolving recipes into local rules.

For testing questions, retrieve current guidance for the installed test integration, test services, virtual clocks, fiber scheduling, and scope teardown. Check which behavior those facilities replace and which still runs against native time or external systems.
