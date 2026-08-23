# Code quality conventions

Prefer a small conceptual surface over a small line count. Good systems code makes ownership, data flow, authority, cost, and failure behavior easy to see.

Use **capability-oriented module design** for shared runtime code:

- **Semantic compression:** Give each concept one owner and one stable term. Remove duplicate concepts before reducing lines.
- **Deep modules:** Use a narrow interface to hide validation, indexing, lifecycle, and cleanup details.
- **Mechanical sympathy:** Bound work before allocation. Compile names once. Retain derived data from immutable inputs. Remove repeated scans before changing representation.
- **Explicit authority:** Pass models, tools, paths, storage roots, credentials, and lifecycle owners as inputs. Do not recover them from unrelated ambient state.
- **Explicit data flow:** Pass canonical values, references, and immutable snapshots. Do not pass live internal objects across ownership boundaries.
- **Small trusted cores:** Keep deterministic transforms plain. Put IO, cancellation, resource ownership, and operational failure in explicit adapters.
- **Low ceremony:** Add an interface, service, layer, or helper only when it improves locality, substitution, lifecycle ownership, or test leverage.

Concise code is not code golf. A shorter implementation is worse when it hides authority, weakens failure behavior, or spreads one concept across more call sites.

Do not add an abstraction for imagined reuse. Require a current ownership, lifecycle, protocol, substitution, or repeated-change need. Follow [change discipline](change-discipline.md) for scope and reuse decisions.

## Module review

Before extracting or merging modules, ask:

1. Which capability does this module own?
2. Can a caller use the interface without knowing internal sequencing?
3. Does the interface expose data that only the implementation needs?
4. Does the change reduce the files needed to understand one behavior?
5. Does the seam own a real authority, lifecycle, protocol, or substitution boundary?
6. Can invalid states or call sequences become harder to express?
7. Does the change preserve a direct rollback or deletion path?

Do not split one cohesive workflow into one-file-per-type modules. Do not combine pure policy, effectful execution, and external adapters only to reduce file count.

## Performance

Use measured end-to-end behavior as the authority.

- Keep bounded simple representations until a profile shows material cost.
- Prefer one-pass data flow and batched immutable publication.
- Do not add timing assertions to blocking tests.
- Do not replace a clear representation because a static metric reports complexity without a locality, safety, or performance problem.

## Comments and documentation

Names, types, decomposition, and tests should explain normal behavior. Use comments for constraints, compatibility history, domain meaning, and safety rationale.

Document stable external, operator, and agent contracts. Link to source owners instead of repeating implementation detail.
