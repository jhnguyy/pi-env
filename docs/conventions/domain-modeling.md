# Domain-first modeling

Model the domain before you implement the workflow. Parse weak or untrusted values into the representation that the workflow needs. Do not validate a weak value and then continue to pass that weak value through the system.

This convention applies the principle from [Parse, don’t validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/).

## Boundary rule

A boundary parser consumes a less-structured value and returns one of these results:

- a domain value that preserves the established invariants
- a typed failure that explains why no domain value exists

Parse before the workflow causes durable or external effects. A parser can use multiple passes when one part of the input determines how to parse another part. Do not mutate state after a partial parse.

Use runtime schemas at persistence, process, network, settings, and tool boundaries. Add semantic parsing when a decoded structural type does not preserve all required invariants.

## Domain representation

Use the most precise practical representation for each workflow.

- Use discriminated unions for mutually exclusive states.
- Use a non-empty representation when an empty collection is invalid.
- Use a map or keyed record when duplicate keys are invalid.
- Use canonical paths and stable identities after filesystem parsing.
- Use opaque or branded values with a smart constructor when a primitive has important constraints that TypeScript cannot otherwise express.
- Keep denormalized state behind one owner when duplication is necessary.

Prefer functions that accept a parsed domain value. Do not make each downstream function accept a broad primitive and repeat the same checks.

A function that checks input only to return `void` deserves review. If the check establishes information that later code needs, return a refined value that carries that information.

## Failure and totality

Make expected parse failures explicit. After parsing succeeds, downstream code must not retain branches for input states that the domain type excludes.

Do not use unchecked casts to claim that parsing occurred. Keep impossible-state assertions rare. When a practical TypeScript limit requires one, keep it inside the parsing owner and document the invariant.

Use judgment. Do not add complex type machinery when a local union or constructor expresses the invariant clearly.

## Review questions

- Does the boundary return a refined value or discard what it learned?
- Can the workflow start effects before all required input is parsed?
- Can the domain type represent a state that the workflow must reject later?
- Does more than one module normalize or validate the same value?
- Does a cast or an “impossible” branch hide a missing parser or domain state?
- Is duplicated mutable information owned behind one boundary?
