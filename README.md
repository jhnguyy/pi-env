# pi-env

Personal [pi](https://github.com/badlogic/pi-mono) environment — extensions, skills, and agent context structured as a dotfiles repo. Treat it as inspiration rather than a starter kit; setups are inherently personalized.

Pi is an interactive CLI coding agent. It reads, edits, and executes code via built-in tools, with an extension system for adding custom tools and behaviors.

## What this is

A **dotfiles repo for AI-assisted work**. The same way shell dotfiles personalize a terminal, pi-env personalizes the agent: what tools it has, how it behaves, what it knows about recurring workflows. It's registered as a [pi package](https://github.com/badlogic/pi-mono#packages) so extensions and skills load directly from the repo — no per-item symlinks.

## What's included

**Extensions** live in `.pi/extensions/` and are registered via `package.json`. Each is a TypeScript module that registers tools and/or hooks. For the full list and build instructions, see [CONTRIBUTING.md](CONTRIBUTING.md).

**Skills** live in `.agents/skills/` and are markdown instruction files pi loads on demand. Auto-discovered skills are matched by description; `reference/` skills are loaded manually via `/skill:name`.

**Roles** live in `.agents/roles/` — behavioral contracts (scout, worker, orchestrator, reviewer) for multi-agent orchestration. Each role file is the source of truth for what that role should and shouldn't do.

**Theme** — a Gruvbox color scheme for pi's TUI (`themes/`), tmux (`setup/tmux.conf`), and VS Code (`vscode/`). `setup.sh` wires all three.

## How it loads

`setup.sh` registers the repo as a pi package in `~/.pi/agent/settings.json`. Pi's package manager reads the `pi` key in `package.json` and loads extensions, skills, and themes directly from the repo — no per-item symlinks. Local extensions in `~/.pi/agent/extensions/` and local skills in `~/.agents/skills/` coexist cleanly via pi's auto-discovery.

```
package.json  →  pi.extensions / pi.skills / pi.themes
setup.sh      →  settings.json (package registration, theme, symlinks, hooks)
AGENTS.md     →  bootstrapped once to ~/.pi/agent/AGENTS.md (global principles)
.pi/agent/APPEND_SYSTEM.md  →  appended to every session's system prompt
```

**Two AGENTS.md files:**
- `AGENTS.md` (root) — global principles, environment notes, and behavioral defaults. Bootstrapped to `~/.pi/agent/AGENTS.md` on first `setup.sh` run. Edit the local copy for machine-specific content; it's never overwritten.
- `.pi/AGENTS.md` — compressed codebase index for pi-env itself. Helps agents orient to the repo structure without reading files top-to-bottom.

## Setup

Prerequisites: `git` and [bun](https://bun.sh) ≥ 1.3.

```bash
git clone <your-fork> ~/pi-env
cd ~/pi-env
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.profile to persist
./setup.sh
```

`setup.sh` is self-documenting — read its header for exactly what it does and what it leaves alone. After setup, review `~/.pi/agent/settings.json` to set your default model and permission level.

Optional tools that extend `dev-tools` coverage if present on `$PATH`:
- `nil` — Nix LSP (`.nix` diagnostics, hover, symbols)
- `hclfmt` — HCL formatter (post-edit format checks on `.hcl` files)

## Updating

```bash
git pull     # post-merge hook calls setup.sh automatically
```

Or run `./setup.sh` manually to pick up new extensions and rebuilt binaries.

## Local-only customization

Anything not meant for the repo goes in the standard local locations — pi discovers them independently of this package:

| Resource | Local path |
|---|---|
| Extensions | `~/.pi/agent/extensions/<name>/` |
| Skills | `~/.agents/skills/<name>/` |
| Models | `~/.pi/agent/models.json` |
| Settings | `~/.pi/agent/settings.json` |
| Global context | `~/.pi/agent/AGENTS.md` |
| System prompt additions | `~/.pi/agent/APPEND_SYSTEM.md` |

## Further reading

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — branch conventions, building extensions, worktree workflow, tests
- **[docs/pi-bun-binary.md](docs/pi-bun-binary.md)** — why pi runs as a compiled Bun binary and how it's built
- **[docs/pi-capability-map.md](docs/pi-capability-map.md)** — auto-generated index of pi's built-in capabilities
- **[pi docs](https://github.com/badlogic/pi-mono)** — upstream reference for extensions API, skills spec, settings
