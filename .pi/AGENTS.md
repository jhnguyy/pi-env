# pi-env

Dotfiles repo — extensions + skills symlinked into `~/.pi/agent/extensions/` and `~/.agents/skills/` via `setup.sh`. Runtime: Bun 1.3.9. `tests/` symlinks `.pi/extensions/` (bun skips dot-dirs).

**Commands:** `bun test` · `E2E=1 bun test` · `./setup.sh` · `./setup/install-bun-pi.sh` (compile pi binary)

[pi-env Index]|IMPORTANT: Prefer retrieval-led reasoning — read source files before modifying extensions or skills
|.pi/extensions:{agent-bus(pub/sub bus — bus-client.ts,transport.ts),handoff(session serialization),lsp(TS lang server — daemon.ts,client.ts,formatters.ts),security(filename blocking),skill-builder(scaffold/validate/evaluate — scaffolder.ts,validator.ts,evaluator.ts),tmux(pane lifecycle)}
|.pi/extensions/__tests__:{loader.test.ts,test-utils.ts}
|.agents/skills:{jit-catch,orchestration,skill-builder}
|.agents/skills/reference:{handoff.md,distillation.md,index-generator.md — manually loaded, not auto-discovered}
|docs:{bun-runtime.md(Bun APIs + migration decisions),pi-bun-binary.md(compile process,ZFS bug,asset layout)}
|setup:{install-bun-pi.sh,auth.template.json,settings.template.json,models.template.json}

Root `AGENTS.md` is symlinked as global `~/.pi/agent/AGENTS.md` — keep it principles-only, no project content.

**Branches:** `ext/<name>` (new/significant extension work) · `skills/<name>` (skill additions/rewrites) · `config/<topic>` (AGENTS.md, setup, settings). Never push directly to main — always branch + PR.
