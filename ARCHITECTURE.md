# Architecture

Progressive disclosure of the pi-env codebase. Read the level you need:

- **L0** — What exists (always read first)
- **L1** — Where to work given an intent
- **L2** — Patterns and conventions to follow when building

---

## L0 — Inventory

### Extensions (`.pi/extensions/`)

| Extension | Purpose | Key files |
|-----------|---------|-----------|
| `agent-bus` | Inter-agent pub/sub message bus over filesystem channels | `bus-service.ts` (server), `bus-client.ts` (client), `transport.ts` (fs layer) |
| `dev-tools` | LSP integration — diagnostics, hover, definition, references, symbols | `daemon.ts` (standalone process), `client.ts` (socket client), `handlers.ts` (LSP actions) |
| `jit-catch` | Ephemeral catching tests for code diffs | `runner.ts` (test execution), `parser.ts` (diff parsing) |
| `local-date` | Fixes UTC→local date in system prompt | `index.ts` (single file, `before_provider_request` hook) |
| `orch` | Multi-agent orchestration with worktree isolation | `manager.ts` (lifecycle), `git.ts` (worktree ops) |
| `security` | Hard-blocks dangerous commands, redacts sensitive file reads | `blocklist.ts` (patterns), `credential-scanner.ts` (filename matching) |
| `skill-builder` | Create and validate pi skills | `scaffolder.ts`, `validator.ts`, `evaluator.ts` |
| `subagent` | In-process subagent via `agentLoop()` | `execute.ts` (loop runner), `agents.ts` (discovery), `render.ts` (TUI) |
| `tmux` | Tmux pane management for parallel work | `tmux-service.ts` (lifecycle), `pane-manager.ts` (registry), `tmux-client.ts` (commands) |
| `work-tracker` | Branch guards, todo tracking, git status widget | `branch-guard.ts`, `store.ts` (todos), `hooks.ts` (lifecycle), `context.ts` (git status) |

### Shared Primitives (`_shared/`)

| Module | Purpose |
|--------|---------|
| `result.ts` | `ok()`, `err()`, `txt()` — tool return values |
| `errors.ts` | `BaseExtensionError<Code>`, `formatError()` — typed errors + catch formatting |
| `render.ts` | `defaultRenderResult()` — TUI success/error rendering |
| `git.ts` | `gitSync()`, `getCurrentBranch()`, `getDirtyCount()` — sync git primitives |
| `id.ts` | `generateId()` — random hex IDs |
| `exit-shim.ts` | `ensureExitShim()` — bus exit signal for tmux panes |

See `_shared/README.md` for intent→module mapping with examples.

### Agents (`.agents/roles/` and `~/.pi/agent/agents/`)

| Agent | Location | Purpose |
|-------|----------|---------|
| `scout` | `~/.pi/agent/agents/scout.md` | Read-only structural recon — file layout, types, entry points |
| `gatherer` | `~/.pi/agent/agents/gatherer.md` | Answer questions with citations from code or notes |
| `workspace-init` | `~/.pi/agent/agents/workspace-init.md` | Intent-driven context assembly — reads this file, explores relevant modules |

### Skills (`.agents/skills/`)

| Skill | Purpose |
|-------|---------|
| `orchestration` | Multi-agent dispatch patterns, scoping, completion signaling |
| `jit-catch` | Catching test promotion criteria |
| `skill-builder` | Skill creation and validation |
| `reference/handoff` | Session handoff format |
| `reference/index-generator` | Compressed navigational indexes |
| `reference/distillation` | Compress verbose docs into dense references |

### Other

| Path | Purpose |
|------|---------|
| `themes/gruvbox.json` | Custom TUI theme |
| `scripts/generate-capability-map.sh` | Regenerate `docs/pi-capability-map.md` from upstream |
| `scripts/restart-lsp-daemon.sh` | Postinstall hook — stops LSP daemon for fresh restart |
| `CONTRIBUTING.md` | Branch conventions, merge workflow |

---

## L1 — Intent Map

### "I want to add a new extension"

1. Create `.pi/extensions/<name>/` with `index.ts` and `package.json`
2. `index.ts` exports a default function that receives `ExtensionAPI`
3. Register tools with `pi.registerTool()`, hooks with `pi.on()`
4. Use `_shared/result.ts` for returns, `_shared/errors.ts` for typed errors
5. See `tmux/index.ts` for the simplest complete example

### "I want to add a tool to an existing extension"

1. Read the extension's `index.ts` to understand its registration pattern
2. Tools follow: `parameters` (typebox schema) → `execute` (async, returns `ok()`/`err()`) → `renderCall`/`renderResult` (TUI)
3. Multi-action tools use `switch (params.action)` with validation per case

### "I want to hook into the extension lifecycle"

Key hooks in execution order:
- `session_start` → initialize state, register AgentTools for subagents
- `before_agent_start` → inject context messages (widgets, status lines)
- `tool_call` → intercept/block before execution (return `{ block, reason }`)
- `tool_result` → modify/augment results after execution
- `session_switch`, `session_shutdown` → cleanup

### "I want to add a shared utility"

1. Check `_shared/README.md` — it might already exist
2. Add to `_shared/` with `@module`/`@purpose` JSDoc
3. Update `_shared/README.md` intent→module table
4. Update this file's L0 `_shared` table

### "I want to add or modify an agent"

- User agents: `~/.pi/agent/agents/<name>.md` — available in all projects
- Project agents: `.pi/agents/<name>.md` — scoped to this repo
- Format: YAML frontmatter (`name`, `description`, `tools`, `model`) + system prompt body
- See `scout.md` for minimal example, `workspace-init.md` for intent-driven pattern

### "I want to add a skill"

1. Read the `skill-builder` skill: `.agents/skills/skill-builder/SKILL.md`
2. Skills live in `.agents/skills/<name>/SKILL.md`
3. Format: YAML frontmatter + markdown body with instructions
4. Skills are loaded on-demand via `reference_skill` tool

### "I want to work on orchestration / multi-agent"

Read the orchestration skill first: `.agents/skills/orchestration/SKILL.md`
Key extensions: `orch` (lifecycle), `agent-bus` (messaging), `tmux` (panes)
Flow: `orch start` → `orch spawn` × N → `bus wait` → read results → `orch cleanup`

### "I want to work on the LSP / dev-tools daemon"

Architecture: `client.ts` ↔ Unix socket ↔ `daemon.ts` ↔ `backend.ts` ↔ language servers
- Client spawns daemon on demand, retries on timeout, auto-restarts stale daemons
- Daemon manages multiple backends (TypeScript, Bash, Nix) via `LspBackend`
- Backends start lazily on first file request, routed by file extension
- `handlers.ts` implements each LSP action (diagnostics, hover, definition, etc.)
- Tests in `lsp/__tests__/` (E2E) and `dev-tools/__tests__/` (unit)

### "I want to work on security"

Two concerns, no interaction:
1. `tool_call` hook — hard-blocks dangerous patterns (see `blocklist.ts`)
2. `tool_result` hook — redacts sensitive file reads (see `credential-scanner.ts`)
No tools registered. No UI. Block means block.

---

## L2 — Patterns

### Tool Registration Pattern

Every tool follows this skeleton:

```typescript
import { txt, ok, err } from "../_shared/result";
import { formatError } from "../_shared/errors";
import { defaultRenderResult } from "../_shared/render";

pi.registerTool({
  name: "tool-name",
  label: "Tool Name",
  description: "...",
  promptSnippet: "...",           // required for system prompt inclusion
  promptGuidelines: ["..."],      // optional behavioral hints
  parameters: Type.Object({ ... }),

  async execute(_toolCallId, params, _signal) {
    try {
      switch (params.action) {
        case "do-thing": {
          if (!params.required) return err("do-thing requires required");
          // ... business logic ...
          return ok("result text");
        }
        default: return err(`Unknown action: ${params.action}`);
      }
    } catch (e) {
      return err(formatError(e, "tool-name"));
    }
  },

  renderCall(args, theme) {
    let text = theme.fg("toolTitle", theme.bold("tool-name"));
    text += " " + theme.fg("accent", args.action ?? "");
    return new Text(text, 0, 0);
  },

  renderResult(result, _opts, theme) {
    return defaultRenderResult(result, theme);
  },
});
```

### Error Handling

1. Define error codes: `export type MyErrorCode = "NOT_FOUND" | "INVALID";`
2. Define error class: `export class MyError extends BaseExtensionError<MyErrorCode> {}`
3. Throw in business logic: `throw new MyError("thing broke", "NOT_FOUND");`
4. Catch in execute: `return err(formatError(e, "my-ext"));`
   → produces: `"my-ext error [NOT_FOUND]: thing broke"`

### Result Shape Convention

All tools return `{ content: [{ type: "text", text }], details }`.
- `ok(text)` → `details: {}` → green ✓ in TUI
- `err(msg)` → `details: { error: msg }` → red in TUI
- Custom: `{ content: [txt(body)], details: { ...rich } }` → custom `renderResult`

`defaultRenderResult` checks `result.details.error` to decide color.

### Hook Return Conventions

| Hook | Return to act | Return to pass through |
|------|--------------|----------------------|
| `tool_call` | `{ block: true, reason }` | `undefined` / void |
| `tool_result` | `{ content: [...] }` | `undefined` / void |
| `before_agent_start` | `{ message: { customType, content, display } }` | `{}` |

### Testing

- Tests live in `<extension>/__tests__/`
- Run all: `bun test`
- Run one extension: `bun test .pi/extensions/<ext>/__tests__/`
- E2E tests (tmux, LSP) are skipped by default — set env vars to enable
- Use `jit-catch` for ephemeral tests on diffs; promote to hardening tests if the criterion should never regress

### File Layout Convention

```
.pi/extensions/<name>/
  index.ts          — entry point (default export, receives ExtensionAPI)
  types.ts          — error classes, type definitions
  *.ts              — business logic modules
  package.json      — { "name": "<name>", "version": "0.1.0" }
  __tests__/        — test files (*.test.ts)
```
