---
name: effect-typescript
description: Use when interacting with TypeScript.
---

# Effect TypeScript

## Purpose

Use this reference when working in TypeScript codebases where Effect is already present or where the user explicitly wants Effect-oriented implementation or review. Keep the guidance architectural and verify exact API names against the project's installed Effect version and existing code.

## Durable Adoption Principles

- Model non-trivial workflows as typed Effect programs instead of mixing promises, thrown exceptions, and ad-hoc control flow.
- Keep tiny deterministic helpers plain when that makes the workflow easier to read.
- Decode external input at the edge before passing values inward.
- Represent expected operational failures as typed/tagged errors with fields that are useful for tests, rendering, and recovery.
- Make dependencies explicit when they cross module boundaries or block tests.
- Scope resource acquisition and release so cleanup behavior is part of the workflow.
- Prefer declarative timeout, retry, cancellation, logging, and observability policy over bespoke loops and scattered flags.
- Preserve public framework/tool APIs during migration unless the project intentionally exposes Effect as part of its public contract.

## Where Effect Usually Pays Off

Prioritize TypeScript modules that own one or more of these concerns:

- filesystem, network, subprocess, browser, database, daemon, model, clock, or randomness dependencies
- configuration, environment variables, persisted state, RPC payloads, tool parameters, or CLI input
- expected failures that callers should render, retry, classify, or test
- resource acquisition and guaranteed cleanup
- timeout, retry, cancellation, batching, logging, metrics, or tracing
- stateful coordination such as sessions, queues, caches, locks, batching, or debounce policy

Leave deterministic mappers, formatters, renderers, predicates, constants, and small algorithms plain unless they need workflow context.

## Migration Workflow

1. Identify the workflow boundary and success/failure/dependency shape.
2. Keep exported compatibility first; run the Effect program at the existing API boundary.
3. Decode external input at that boundary and pass typed values inward.
4. Replace expected thrown errors or string failures with typed operational errors.
5. Introduce services/layers only where they improve substitution, portability, or test seams.
6. Move resource acquisition/use/release into one scoped workflow.
7. Replace manual retry/timeout/cancellation code with project-approved Effect primitives.
8. Add focused tests for malformed input, error rendering, cleanup, and compatibility behavior.

## Review Checklist

- Does this module contain orchestration rather than only pure helpers?
- Are success, expected failure, and dependency requirements visible in types?
- Are external inputs decoded once at the edge?
- Can tests substitute filesystem/process/network/browser/model dependencies without reaching through internals?
- Is cleanup guaranteed when the main operation fails or is interrupted?
- Does the public API remain compatible with existing callers?
- Are exact API choices consistent with the installed Effect version and nearby project examples?

## Anti-patterns

- Migrating pure leaves first while orchestration remains promise/throw soup.
- Leaking Effect into public APIs accidentally.
- Hiding expected operational failures in untyped `Error` strings.
- Building service/layer abstractions for one-line pure functions.
- Writing dense point-free code when named intermediate workflows would be clearer.
- Encoding retry, timeout, or cleanup policy in scattered local conditionals.
