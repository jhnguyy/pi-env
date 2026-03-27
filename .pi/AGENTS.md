# pi-env

Dotfiles repo — registered as a pi package via `settings.json` `packages` entry. Extensions and skills are loaded directly from the repo by pi's package manager. Binary compiled via `setup/install-bun-pi.sh`. Runtime: Bun 1.3.

**Commands:** `bun test` · `E2E=1 bun test` · `./setup.sh` · `./setup/install-bun-pi.sh` (compile pi binary)

[pi-env Index]|IMPORTANT: Prefer retrieval-led reasoning — read source files before modifying extensions or skills
|.pi/extensions:{agent-bus(pub/sub bus — bus-client.ts,bus-service.ts,transport.ts),jit-catch(ephemeral test generation — parser.ts,runner.ts),dev-tools(lang/format tools — backend.ts,handlers.ts,daemon.ts,client.ts,formatters.ts,filetypes.ts),orch(orchestration lifecycle — manager.ts,git.ts,manifest.ts),security(filename blocking,credential scanning — blocklist.ts,credential-scanner.ts),skill-builder(scaffold/validate/evaluate — scaffolder.ts,validator.ts,evaluator.ts),subagent(in-process subagent — execute.ts,discovery.ts,render.ts),tmux(pane lifecycle — pane-manager.ts,tmux-client.ts),work-tracker(branch guard,handoff — hooks.ts,commands.ts,context.ts,store.ts,extractor.ts)}
|.pi/extensions/_shared:{result.ts(txt/ok/err helpers),errors.ts(BaseExtensionError base),git.ts(git op wrappers),exit-shim.ts(bus signal on exit) — shared utilities, not a pi extension}
|.pi/extensions/__tests__:{loader.test.ts,test-utils.ts(mock helpers)}
|.pi/agents:{scout(structural recon),gatherer(question answering with citations),workspace-init(intent-driven context assembly)}
|.agents/skills:{jit-catch,orchestration,skill-builder,index-practices}
|.agents/skills/reference:{handoff.md,distillation.md,index-generator.md — manually loaded, not auto-discovered}
|docs:{pi-bun-binary.md(compile process,ZFS bug,asset layout)}
|setup:{install-bun-pi.sh,settings.template.json,models.template.json}

Root `AGENTS.md` is symlinked as global `~/.pi/agent/AGENTS.md` — keep it principles-only, no project content.

**Branches:** `feat/<name>` (new extension/tool/capability) · `fix/<name>` (bug fix) · `chore/<name>` (config, docs, cleanup). See CONTRIBUTING.md.
