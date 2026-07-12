---
name: effect-typescript
description: Use for TypeScript work where Effect is in use or proposed for use.
---

# Effect TypeScript

## Retrieve

1. Inspect the project's Effect dependency, configuration, conventions, and nearby code.
2. Verify APIs against the project's installed declarations.
3. Consult installed source only after confirming version compatibility.
4. Treat the repository typecheck and runtime tests as authoritative when external guidance targets a different Effect release.

## Apply

- Start from the workflow's success, expected-failure, and dependency shape.
- Decode untrusted input at the edge and model expected failures explicitly.
- Use Effect for IO, interruption, scoped resources, concurrency policy, or dependency substitution.
- Keep deterministic transforms plain TypeScript.
- Add services or layers only for meaningful substitution or lifecycle ownership.
- Preserve public adapters unless the task intentionally changes them; run the Effect program at the existing boundary.
