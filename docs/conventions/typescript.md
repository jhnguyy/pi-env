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

## Effect-style tagged data

For algebraic data types or error/result variants, prefer tagged objects/classes over enums. With Effect, use patterns such as `Data.TaggedError`, `_tag` discriminants, or `Data.taggedEnum`-style constructors when they fit the boundary. Keep tags as literal values derived from objects or constructors rather than TypeScript enums.

## Effect seams and compatibility wrappers

For IO-heavy orchestration, boundary validation, or workflows with multiple expected failure modes, prefer an Effect/Either-returning core API and keep throwing or Promise-returning wrappers at compatibility edges.

Good candidates:

- extension workflows that shell out, touch the filesystem, or prepare artifacts
- request builders and validators that can fail from user/tool input
- shared helpers where callers benefit from typed failure data in tests

Pattern:

```ts
export function prepareThingEffect(input: Input): Effect.Effect<Thing, ThingError> {
  // typed workflow
}

export function prepareThing(input: Input): Promise<Thing> {
  return Effect.runPromise(prepareThingEffect(input));
}
```

Use `Either` for synchronous validation or pure parsing. Use `Effect` when the operation performs IO, needs acquire/use/release, or composes async steps. Do not convert every local helper mechanically; add the Effect seam where typed errors improve locality, test leverage, or boundary clarity.

Bootstrap scripts that run before dependencies are installed must not import dependency-backed Effect modules at top level. Keep a dependency-free compatibility boundary for preinstall/runtime bootstrap, then enter Effect-based modules after install has made dependencies available.
