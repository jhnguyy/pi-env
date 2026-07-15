# TypeScript conventions

## Const objects for named value sets

Prefer `as const` objects plus derived value types for named sets of string or number values, especially when the values cross module boundaries:

- tool actions
- protocol action names
- modes and states
- lifecycle event names
- config values represented in code
- public helper return tags

Use object members at call sites instead of repeating raw literals.

```ts
export const LoadState = {
  Load: "load",
  DomContentLoaded: "domcontentloaded",
  NetworkIdle: "networkidle",
} as const;
export type LoadState = typeof LoadState[keyof typeof LoadState];

await page.waitForLoadState(LoadState.DomContentLoaded);
```

This keeps the enum-like calling style without TypeScript enum emit.

## Avoid TypeScript enums

Do not introduce `enum` or `const enum` for new code. TypeScript enums emit TypeScript-specific runtime code, numeric enums create reverse mappings, and `const enum` creates toolchain/module-boundary pitfalls with transpilers and published types.

Use explicit reverse maps only when reverse lookup is actually needed.

## Local literal unions

String unions are acceptable for small local implementation details where no runtime value or cross-module symbol is useful.

```ts
type LocalPathMode = "none" | "single" | "many";
```

Do not replace every local union mechanically. Prefer the const-object pattern when the value set is a durable repo concept or public seam.

## Branching and classification

Prefer `switch` when branching on an explicit discriminant or named value set:

- parser tokens
- tool actions
- protocol actions
- tagged result states
- enum-like const object values

```ts
switch (action) {
  case ToolAction.Diagnostics:
    return runDiagnostics(input);
  case ToolAction.Hover:
    return runHover(input);
}
```

Prefer guard clauses for preconditions, exceptional cases, and simple boolean checks.

```ts
if (!path) return skipped("missing path");
if (isDirty(path)) return skipped("worktree has uncommitted changes");
```

Avoid cascading `if`/`else if` for state-machine or parser logic. Avoid forcing `switch (true)` when naming the classification first would be clearer; derive a small const-object state, then switch on that state.

## Effect-style tagged data

For algebraic data types or error/result variants, prefer tagged objects/classes over enums. With Effect, use patterns such as `Data.TaggedError`, `_tag` discriminants, or `Data.taggedEnum`-style constructors when they fit the boundary. Keep tags as literal values derived from objects or constructors rather than TypeScript enums.

## Effect integration

Follow [Effect guardrails](effect-guardrails.md) for Effect-vs-Result selection, typed failure, services and layers, compatibility wrappers, lifecycle, and dependency-free bootstrap. This page owns the TypeScript representation guidance above.
