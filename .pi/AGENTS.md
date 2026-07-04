# pi-env

Dotfiles repo — registered as a pi package via `settings.json` `packages` entry. Extensions and skills are loaded directly from the repo by pi's package manager. `setup.sh` installs the pi CLI with npm into a user-local prefix, installs repo dependencies, and builds extension bundles. Runtime: Node.js 22.19+.

**Commands:** `npm test` · `E2E=1 npm run test:e2e` · `npm run build` · `./setup.sh`

[pi-env Index]|IMPORTANT: Prefer retrieval-led reasoning.

Before editing, retrieve established conventions first: `README.md` for runtime/setup expectations, `CONTRIBUTING.md` for workflow, `AGENTS.md` for development principles, package scripts for command source of truth, and nearby tests/modules for local style. If prior session context may matter, use `list_sessions` to find compact session digests before `read_session`.

Root `AGENTS.md` is bootstrapped to `~/.pi/agent/AGENTS.md` on first setup — keep it principles-only, no project content.

**Branches:** `feat/<name>` (new extension/tool/capability) · `fix/<name>` (bug fix) · `chore/<name>` (config, docs, cleanup). See CONTRIBUTING.md.
