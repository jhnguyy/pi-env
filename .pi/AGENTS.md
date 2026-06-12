# pi-env

Dotfiles repo — registered as a pi package via `settings.json` `packages` entry. Extensions and skills are loaded directly from the repo by pi's package manager. `setup.sh` installs the pi CLI with npm into a user-local prefix, installs repo dependencies, and builds extension bundles. Runtime: Node.js 22.19+.

**Commands:** `npm test` · `E2E=1 npm run test:e2e` · `npm run build` · `./setup.sh`

[pi-env Index]|IMPORTANT: Prefer retrieval-led reasoning — read source files before modifying extensions or skills
|.pi/agents:{scout(structural recon),gatherer(question answering with citations),workspace-init(intent-driven context assembly)}
|.agents/skills:{jit-catch,orchestration,skill-builder,index-practices}
|.agents/skills/reference:{handoff.md,distillation.md,index-generator.md — manually loaded, not auto-discovered}
|setup:{settings.template.json,models.template.json}

Root `AGENTS.md` is bootstrapped to `~/.pi/agent/AGENTS.md` on first setup — keep it principles-only, no project content.

**Branches:** `feat/<name>` (new extension/tool/capability) · `fix/<name>` (bug fix) · `chore/<name>` (config, docs, cleanup). See CONTRIBUTING.md.
