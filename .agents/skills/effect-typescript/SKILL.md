---
name: effect-typescript
description: Use for TypeScript work involving Effect APIs, design, migration, diagnostics, schemas, errors, services, or resource lifecycles.
---

# Effect TypeScript

## Retrieve

1. Run `effect-solutions list`.
2. Run `effect-solutions show <topic>...` for only the relevant guides.
3. Inspect the project's Effect dependency, configuration, conventions, and nearby code.
4. Verify APIs against installed types. Consult source only after confirming version compatibility.

If Effect Solutions is unavailable, say so and continue from project evidence; do not guess APIs or patterns.

## Apply

- Start from the workflow's success, expected-failure, and dependency shape.
- Decode untrusted input at the edge and model expected failures explicitly.
- Use Effect for IO, interruption, scoped resources, concurrency policy, or dependency substitution.
- Keep deterministic transforms plain TypeScript.
- Add services or layers only for meaningful substitution or lifecycle ownership.
- Preserve public adapters unless the task intentionally changes them; run the Effect program at the existing boundary.

## Validate

Run focused tests and the project typecheck. Do not suppress new Effect language-service diagnostics unless the project explicitly baselines them.
