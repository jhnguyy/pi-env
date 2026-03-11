# pi-env

Dotfiles repo — registered as a pi package via `settings.json` `packages` entry. Extensions and skills are loaded directly from the repo by pi's package manager. Binary compiled via `setup/install-bun-pi.sh`. Runtime: Bun 1.3.

**Commands:** `bun test` · `E2E=1 bun test` · `./setup.sh` · `./setup/install-bun-pi.sh` (compile pi binary)

[pi-env Index]|IMPORTANT: Prefer retrieval-led reasoning — read source files before modifying extensions or skills
|.pi/extensions:{agent-bus(pub/sub bus — bus-client.ts,transport.ts),jit-catch(ephemeral test generation — parser.ts,runner.ts),lsp(TS lang server — daemon.ts,client.ts,formatters.ts),orch(orchestration lifecycle — manager.ts,git.ts,manifest.ts),security(filename blocking,credential scanning),skill-builder(scaffold/validate/evaluate — scaffolder.ts,validator.ts,evaluator.ts),subagent(in-process subagent via agentLoop),tmux(pane lifecycle — pane-manager.ts,tmux-client.ts),work-tracker(branch guard,handoff — store.ts,extractor.ts)}
|.pi/extensions/__tests__:{loader.test.ts,test-utils.ts}
|.agents/skills:{jit-catch,orchestration,skill-builder}
|.agents/skills/reference:{handoff.md,distillation.md,index-generator.md — manually loaded, not auto-discovered}
|docs:{pi-bun-binary.md(compile process,ZFS bug,asset layout)}
|setup:{install-bun-pi.sh,settings.template.json,models.template.json}

Root `AGENTS.md` is symlinked as global `~/.pi/agent/AGENTS.md` — keep it principles-only, no project content.

**Branches:** `feat/<name>` (new extension/tool/capability) · `fix/<name>` (bug fix) · `chore/<name>` (config, docs, cleanup). See CONTRIBUTING.md.
