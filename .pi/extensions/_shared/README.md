# _shared — Extension Primitives

Reusable building blocks for pi-env extensions. **Check here before writing
new utility code in an extension** — the pattern you need probably exists.

Grep for `@purpose` in the source files for per-module context.

## Intent → Module

| When you need to…                         | Use                                    | Module       |
|-------------------------------------------|----------------------------------------|--------------|
| Return success/failure from a tool        | `ok()`, `err()`, `txt()`              | result.ts    |
| Format a caught error in a catch block    | `formatError(e, "label")`             | errors.ts    |
| Define a typed extension error class      | `extends BaseExtensionError<Code>`    | errors.ts    |
| Render success/error in the TUI           | `defaultRenderResult(result, theme)`  | render.ts    |
| Run a git command synchronously           | `gitSync(cwd, args)`                  | git.ts       |
| Get current branch / dirty count         | `getCurrentBranch()`, `getDirtyCount()` | git.ts    |
| Generate a random hex ID                  | `generateId()`                        | id.ts        |
| Ensure bus exit-signal shim exists        | `ensureExitShim()`                    | exit-shim.ts |
| Guard widget/status rendering             | `isHeadless(ctx)`                     | context.ts   |
| Guard LLM context injection in workers   | `isOrchWorker()`                      | context.ts   |

## Conventions

- **result shape**: Every tool returns `{ content: [{ type: "text", text }], details }`.
  Use `ok()`/`err()` for the common case; use `txt()` + custom details when you
  need richer render data.
- **error detection**: `defaultRenderResult` checks `result.details.error` to decide
  red vs green. `err()` sets this automatically.
- **formatError**: Handles `BaseExtensionError` (includes `[code]`), plain `Error`,
  and unknown. Use in every tool catch block for consistency.
- **git operations**: Always synchronous, never throw. Caller checks `status === 0`.
