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
| Set a named UI slot (widget or status)   | `setSlot(key, content, ctx)`          | ui-render.ts |
| Clear a named UI slot                    | `clearSlot(key, ctx)`                 | ui-render.ts |
| Re-render all slots from current state   | `flush(ctx)`                          | ui-render.ts |
| Reset slot state on session shutdown     | `resetSlots()`                        | ui-render.ts |

