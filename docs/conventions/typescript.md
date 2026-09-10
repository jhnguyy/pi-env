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

## Preserve type evidence

Keep the most specific type that the program has established. Do not widen a known value to `unknown`, `any`, `object`, `{}`, or an open dictionary and assert it back later.

- `no-known-value-widening` preserves inferred keys and concrete value types. Use `satisfies` when a value must conform to a broader contract.
- `no-widen-then-assert` prevents a local widen-and-recover sequence.
- `no-unknown-type-aliases` prevents aliases that hide `unknown` without adding a contract.
- `no-unknown-parameters` and `no-unknown-returns` keep unknown data at parsing boundaries. A type predicate can accept the exact value that it narrows.
- `no-object-parameters` requires a named owner type instead of the broad `object` type.
- `no-unsafe-dictionary-type` requires a concrete value contract for dictionary entries. A generic constraint can use `Record<string, unknown>` when the caller supplies the concrete type.

Decode external data at its adapter boundary. Pass the decoded domain value to internal functions. The `no-runtime-typeof` rule rejects ad hoc `typeof` narrowing. An existence probe such as `typeof document === "undefined"` is valid because it checks whether a binding exists.

Prefer direct typed calls and property access. The `no-reflect-apply` and `no-reflect-get` rules prevent reflection from bypassing a missing contract.

## Type assertions

Treat a type assertion as a local proof obligation.

- `no-chained-type-assertions` rejects assertion chains that fabricate compatibility. A chain that contains only `as const` is valid.
- `require-safety-comment-for-type-assertion` requires a nearby `SAFETY:` comment. State the checked invariant that makes the assertion valid.
- Do not move an assertion or add an empty marker only to satisfy lint. Prefer a parser, predicate, constructor, or stronger owner type when one is available.

## Data flow and allocation

Prefer one-pass data flow when separate eager passes or repeated accumulator copies add no useful boundary.

- `no-array-filter-map` rejects adjacent eager array `filter` and `map` passes. Use a supported iterator pipeline, one `flatMap`, or a locally mutating reducer. Preserve callback order, indexes, sparse-array behavior, `thisArg`, and filtering semantics.
- `no-reduce-accumulator-copy` rejects copies of a growing reducer accumulator. Mutate and return a fresh local accumulator instead.
- `no-conditional-empty-object-spread` rejects conditional spreads with an empty object branch. Build the object explicitly because omission can differ from assignment to `undefined`.

The custom `no-reduce-accumulator-copy` rule and Oxlint's `oxc/no-accumulating-spread` rule enforce complementary parts of the reducer policy. These syntax checks do not prove that all quadratic reductions are absent.

## Tests and local seams

The `no-module-mocking` rule rejects Vitest and Jest module mocking. Inject the dependency through an existing service, adapter, function parameter, or test constructor. Keep the production ownership boundary visible in the test.

## Names and spacing

The `no-shape-in-symbol-names` rule requires a domain role in each locally owned symbol name. A static member such as `schema.shape` is valid because another API owns that member name.

The `require-readable-spacing` rule separates top-level declarations, multiline bindings, control flow, returns, and completed blocks. Keep imports, overload groups, and short related local bindings together. Run the lint fix before the formatter when this rule is enabled.

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

Avoid cascading `if`/`else if` for state-machine or parser logic. Avoid forcing `switch (true)` when naming the classification first would be clearer. Derive a small const-object state, then switch on that state.

## Effect-style tagged data

For algebraic data types or error/result variants, prefer tagged objects/classes over enums. With Effect, use patterns such as `Data.TaggedError`, `_tag` discriminants, or `Data.taggedEnum`-style constructors when they fit the boundary. Keep tags as literal values derived from objects or constructors rather than TypeScript enums.

## Lint policy and provenance

The repository vendors its custom Oxlint rules at [`tools/oxlint/anti-slop`](../../tools/oxlint/anti-slop). The adjacent `UPSTREAM.md` records the exact source revision, copied paths, licenses, and local changes. The nested ESLint Stylistic provenance applies only to the readable-spacing engine.

This page owns the repository policy. The vendored plugin implements part of that policy. [`.oxlintrc.json`](../../.oxlintrc.json) is the source of truth for the rules that currently block validation.

Changed-code analysis excludes the exact vendored root. Review an update against its recorded upstream revision instead of applying local complexity policy to copied implementation code.

Adopt lint rules in reviewable phases when the existing baseline is large. A phase must keep new suppressions out of owned source, migrate affected code by policy family, and enable each completed rule at `error`. Do not weaken a rule or add unsafe casts only to make validation pass.
