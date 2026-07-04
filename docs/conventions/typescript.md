# TypeScript conventions

## String enums for exported domain values

Prefer exported string enums for domain concepts that cross module boundaries, including:

- tool actions
- protocol action names
- modes and states
- lifecycle event names
- config values represented in code
- public helper return tags

Use enum members at call sites instead of repeating raw string literals.

```ts
export enum LoadState {
  Load = "load",
  DomContentLoaded = "domcontentloaded",
  NetworkIdle = "networkidle",
}

await page.waitForLoadState(LoadState.DomContentLoaded);
```

String unions are acceptable for small local implementation details where no runtime value or cross-module symbol is useful.

```ts
type LocalPathMode = "none" | "single" | "many";
```

## Why

String enums make shared concepts easier to discover, import, refactor, and test. They also keep runtime wire values stable while giving code a named symbol.

String unions are still useful for purely local type constraints, inferred literals, and template-literal type composition. Do not replace every union mechanically; prefer enums when the value is part of a durable repo concept or public seam.

## Performance note

String enums emit a small runtime object. In this repo that cost is negligible for public actions, states, and protocol values. Prefer clarity and consistency at boundaries over zero-runtime unions. For hot local internals, keep literal unions when they are simpler and avoid unnecessary emitted objects.
