---
name: effect-typescript
description: Designs and tests Effect workflows in TypeScript, including typed failures, dependencies, and resource lifecycles. Use when Effect is in use or proposed.
---

# Effect TypeScript

## Check the project's Effect version

1. Inspect the Effect dependency, configuration, conventions, and nearby code.
2. Verify APIs against the project's installed declarations.
3. Confirm version compatibility before consulting installed source.
4. When external guidance targets another Effect release, use the repository typecheck and runtime tests as authoritative.

## Define the workflow boundary

- Start with the workflow's success, expected failures, and dependencies.
- Parse untrusted input at the edge into the refined domain type the workflow needs. Do not validate and continue with the broad input type.
- Model expected parse failures explicitly. Complete required parsing before durable or external effects begin.
- Use Effect for IO, interruption, scoped resources, concurrency policy, or dependency substitution. Keep deterministic transforms in plain TypeScript.
- Add services or layers only for meaningful substitution or lifecycle ownership.
- Preserve public adapters unless the task intentionally changes them. Run the Effect program at the existing boundary.

## Implement and test Effect programs

- Do not use JavaScript `try`/`catch` inside `Effect.gen`. Model expected failures in the Effect error channel.
- Use `return yield*` for terminal failure and interruption effects in `Effect.gen`.
- Prefer `Effect.fnUntraced` for reusable functions that only wrap a generator and do not need tracing metadata.
- Use `Clock` for time in Effect workflows and `TestClock` for deterministic Effect tests.
- Use `it.effect` for Effect-native tests. Do not use `Effect.runSync` only to adapt an Effect-native unit test.
