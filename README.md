# pi-env

My personal [pi](https://github.com/mariozechner/pi) environment — extensions, skills, and agent context structured as a dotfiles repo. Shared as a reference; setups are inherently personalized so treat this as inspiration rather than a starter kit.

pi is an interactive CLI coding agent. It reads, edits, and executes code via a set of built-in tools, with an extension system for adding custom tools and behaviors.

## How it works

```
pi-env/
├── .agents/
│   ├── roles/                # Behavioral contracts for multi-agent orchestration
│   └── skills/               # Skills — markdown instructions loaded by pi on demand
│       └── reference/        # Reference skills (manually loaded, not auto-discovered)
├── .pi/
│   ├── AGENTS.md             # Project-scoped agent context (dense index for orientation)
│   └── extensions/           # Extensions — TypeScript tools and hooks loaded by pi
│       └── _shared/          # Internal utilities shared across extensions
├── docs/                     # Additional documentation
├── setup/                    # Per-machine config templates + install script
├── AGENTS.md                 # Portable agent principles (symlinked to ~/.pi/agent/AGENTS.md)
├── CONTRIBUTING.md           # Branch conventions and workflow
└── setup.sh                  # Idempotent setup — run once, re-run after git pull
```

pi-env is registered as a [pi package](https://github.com/mariozechner/pi#pi-packages) via `settings.json`. Pi's package manager reads the `pi` manifest in `package.json` and loads extensions and skills directly from the repo — no per-item symlinks needed.

`setup.sh` handles:
- `bun install` (frozen lockfile)
- Compiling the pi binary + symlinking assets (`setup/install-bun-pi.sh`)
- Registering pi-env in `settings.json` `packages`
- `~/.pi/agent/AGENTS.md` → repo's `AGENTS.md`
- `~/.agents/roles` → repo's `.agents/roles`
- Git post-merge hook

Local extensions in `~/.pi/agent/extensions/` coexist cleanly — pi auto-discovers them independently of packages.

> **Two AGENTS.md files:** `AGENTS.md` (repo root) is the global principles file — portable across projects, symlinked to `~/.pi/agent/AGENTS.md`. `.pi/AGENTS.md` is a project-scoped dense index that helps agents orient to this specific codebase. Don't mix their concerns.

## What's included

### Extensions

Extensions are TypeScript modules that register **tools** (new capabilities the agent can invoke) and **hooks** (intercepts on tool calls, session lifecycle, and context injection). Each extension lives in `.pi/extensions/<name>/` with an `index.ts` entry point.

| Extension | What it adds |
|---|---|
| `agent-bus` | Filesystem-backed pub/sub between pi processes — `bus start/publish/subscribe/wait/read`. The messaging backbone for multi-agent coordination. |
| `jit-catch` | `jit_catch` tool — spawns a subagent to write ephemeral catching tests for a diff, runs them with `bun test`, auto-discards on pass. |
| `lsp` | `lsp` tool — TypeScript, Bash, and Nix language intelligence: diagnostics, hover, go-to-definition, find-references, document/workspace symbols via a shared daemon. |
| `orch` | `orch` tool — orchestration lifecycle manager: worktree-isolated branches per worker, temp dir cleanup, run receipts. Coordinates `tmux` panes and `bus` channels. |
| `security` | Hook-based permission engine — intercepts tool calls via blocklist rules, scans results for credential leakage and redacts. `/permissions` command. |
| `skill-builder` | `skill_build` tool — scaffold, validate, and evaluate pi skills in one call. |
| `subagent` | `subagent` tool — in-process subagent via `agentLoop()`. Delegates focused tasks without subprocess overhead. Auto-discovers available agents, models, and tools. |
| `tmux` | `tmux` tool — spawn panes, send keystrokes, read output, close. The execution layer for parallel subagent work and long-running services. |
| `work-tracker` | Hook-based branch guard + session tracking — enforces branch naming conventions, injects git context on session start, provides `/handoff` and `/review-retros` commands. |

**How they compose:** `agent-bus`, `tmux`, and `orch` form the multi-agent stack. `tmux` spawns parallel panes, `agent-bus` provides event-driven messaging between them, and `orch` manages the lifecycle (worktree isolation, cleanup, receipts). `security` and `work-tracker` operate via hooks — they intercept tool calls transparently rather than exposing their own tools.

`.pi/extensions/_shared/` contains internal utilities used across multiple extensions: `result.ts` (tool result helpers), `errors.ts` (`BaseExtensionError` base class), `git.ts` (git operation wrappers), `exit-shim.ts` (bus signal on process exit). Not a registered extension — imported directly by other extensions.

### Skills

Skills are markdown instruction files (`SKILL.md`) that pi loads on demand when a task matches their description. They contain patterns, decision rules, and workflows — not code. Skills in `.agents/skills/` are auto-discovered; those in `reference/` must be loaded manually.

| Skill | When it's used |
|---|---|
| `jit-catch` | Decision rule for when to run `jit_catch` vs `bun test` directly |
| `orchestration` | Subagent spawning, bus integration, parallel dispatch patterns |
| `skill-builder` | Building and reviewing pi skills — conventions, templates, evaluation |
| `reference/handoff` | Writing and reading session handoffs |
| `reference/distillation` | Compressing verbose docs and worklogs into dense references |
| `reference/index-generator` | Producing compressed navigational indexes for files or notes |

### Roles

Roles are behavioral contracts for multi-agent orchestration. Each role (`.agents/roles/*.md`) defines what an agent *should and shouldn't do* when assigned that identity:

- **scout** — read-only recon: reports structure, stack, paths, conventions. Never decides or modifies.
- **worker** — bounded implementation: executes a brief, reports changes. Doesn't expand scope.
- **orchestrator** — routing and synthesis: decomposes tasks, dispatches workers, merges results. Doesn't read raw files.
- **reviewer** — adversarial review: assumes the implementation is wrong until proven otherwise.

## Usage

The core loop is conversational: open `pi`, describe the task, and let the model plan and implement while you steer.

**Interactive session** — the default mode. Describe what you want to build or fix, work through the design in conversation, and let the model write the code. Works well for focused single-task sessions.

**Design then build** — for larger or less defined tasks, spend a session on design only: talk through the problem, explore tradeoffs, arrive at a plan. Run `/handoff` at the end to serialize context, then open a fresh session to implement. Keeps the implementation context clean and focused.

**Parallel agents** — for tasks that decompose into independent pieces, use `orch` to fan out workers across isolated worktrees. Each worker gets its own branch; `bus wait` blocks until results arrive; the orchestrator synthesizes. The orchestration skill documents the pattern in detail.

## New machine setup

**Prerequisites:** `git` and [bun](https://bun.sh) (≥1.3) — no npm or node required.

```bash
# Install bun if needed:
curl -fsSL https://bun.sh/install | bash
```

```bash
# 1. Clone
git clone https://github.com/<you>/pi-env.git ~/pi-env
cd ~/pi-env

# 2. Add ~/.local/bin to PATH (once — add to ~/.profile or ~/.bashrc)
export PATH="$HOME/.local/bin:$PATH"

# 3. Run setup — installs deps, compiles pi binary, registers package
./setup.sh

# 4. Copy settings template and customize
cp setup/settings.template.json ~/.pi/agent/settings.json
# Then re-run ./setup.sh to register pi-env in the new settings.json
# Key settings to review: defaultModel, permissionLevel ("none"/"warn"/"block"), theme
# Optional: cp setup/models.template.json ~/.pi/agent/models.json  (add local/ollama models)

# 5. Authenticate — pick one:
#   API key:  export ANTHROPIC_API_KEY=sk-ant-...   (add to ~/.profile to persist)
#   OAuth:    run `pi` then type /login              (auth.json written automatically)
```

### Verify setup

```bash
pi --version            # should print the pi version
pi "say hello"          # quick smoke test — should get a response
```

## Updating

```bash
cd ~/pi-env
git pull
./setup.sh    # re-installs deps, recompiles binary if pi version changed
```

## Local-only extensions and skills

Extensions and skills not in this repo go directly in their local directories:
- `~/.pi/agent/extensions/<name>/` — local-only extensions
- `~/.agents/skills/<name>/` — local-only skills

Pi auto-discovers these independently of packages. They coexist cleanly with pi-env's package-managed resources.

If you have a local `~/.pi/agent/AGENTS.md` with machine-specific context (environment, mounts, etc.), it takes precedence over the repo symlink — remove it to switch to the linked version.

## Running tests

```bash
cd ~/pi-env
bun test                     # all unit tests (e2e skipped by default)
E2E=1 bun test               # include live API tests (requires auth.json)
```

## Why Bun binary instead of npm global

Running pi as a Bun compiled binary avoids CJS/ESM format conflicts in extensions that use Bun-specific APIs — the compiled binary uses pre-bundled virtualModules instead of jiti's Node.js resolution chain. See [`docs/pi-bun-binary.md`](docs/pi-bun-binary.md) for details.
