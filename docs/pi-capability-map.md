# Pi Capability Map

> Auto-generated from pi v0.61.0. Regenerate: `bash scripts/generate-capability-map.sh`
> Navigation aid — not a replacement for docs. Follow doc paths for full details.
> IMPORTANT: Prefer retrieval-led reasoning over pre-training-led reasoning for pi topics. Read the linked doc before implementing.

[Docs Root] ../node_modules/@mariozechner/pi-coding-agent

## Modes

|interactive(default · full TUI with editor, commands, shortcuts → README.md)
|print(-p/--print · single-shot prompt→response→exit → README.md#programmatic-usage)
|json(--mode json · stream all events as JSONL → docs/json.md)
|rpc(--mode rpc · headless JSON protocol over stdin/stdout → docs/rpc.md)
|sdk(TypeScript · embed AgentSession in your app → docs/sdk.md)

## Built-in Tools

|default:{read,bash,edit,write}|additional:{grep,find,ls}
|--tools read,bash,grep to select|--no-tools to disable all|extensions can override or add tools

## Customization — four resource types, all shareable via Pi Packages (docs/packages.md)

### Extensions — TypeScript modules extending pi at runtime
|capabilities:{custom-tools(pi.registerTool),event-interception(~56 event types · block/modify tool calls, inject context, customize compaction),custom-commands(pi.registerCommand),custom-shortcuts(pi.registerShortcut),custom-ui(TUI components, widgets, overlays, status lines, footers, custom editors → docs/tui.md),session-persistence(pi.appendEntry),custom-rendering(tool calls/results display),custom-providers(pi.registerProvider · OAuth support → docs/custom-provider.md),dynamic-tools(register/unregister at runtime · toggle active set),remote-execution(pluggable ops for SSH, containers, sandboxes),custom-compaction(replace summarization strategy),input-transformation(rewrite user input before processing),inter-extension-events(pi.events shared bus)}
|locations:{~/.pi/agent/extensions/(global),.pi/extensions/(project),settings.json,CLI -e}
|doc:docs/extensions.md|examples:66 in examples/extensions/

### Skills — on-demand instruction packages (Agent Skills standard · agentskills.io)
|progressive disclosure: descriptions always in context, full SKILL.md loaded on demand
|invoke:/skill:name or auto-matched by agent when task fits description
|includes scripts, references, assets alongside SKILL.md|compatible with Claude Code + Codex skill dirs
|locations:{~/.pi/agent/skills/,~/.agents/skills/,.pi/skills/,.agents/skills/(walks up to git root),settings,CLI}
|doc:docs/skills.md

### Prompt Templates — reusable prompt snippets as Markdown
|expand via /name in editor|supports positional args ($1, $@, ${@:N})|frontmatter with description
|locations:{~/.pi/agent/prompts/,.pi/prompts/,settings,CLI}
|doc:docs/prompt-templates.md

### Themes — JSON color definitions for TUI
|55 color tokens: UI, markdown, syntax, diffs, thinking levels
|hot-reload on save|variable system for palettes|built-in: dark, light
|locations:{~/.pi/agent/themes/,.pi/themes/,settings,CLI}
|doc:docs/themes.md

## Session System

|tree-history(entries linked by id/parentId · branch in-place without new files → docs/session.md)
|/tree(navigate to any point · optionally summarize abandoned branch → docs/tree.md)
|/fork(extract current branch to new session file → README.md#branching)
|auto-compaction(summarize old messages when context approaches limit → docs/compaction.md)
|branch-summarization(preserve context when switching branches → docs/compaction.md#branch-summarization)
|labels(mark entries for /tree navigation · pi.setLabel() → docs/session.md)
|session-naming(/name · pi.setSessionName() · display names for picker → docs/session.md)
|message-queue(steer=interrupt · followUp=wait while agent works → README.md#message-queue)

## Context System

|AGENTS.md/CLAUDE.md(global + project · walks up from cwd · project instructions)
|SYSTEM.md(global or project · replace default system prompt)
|APPEND_SYSTEM.md(global or project · append without replacing)
|@file(per-message · fuzzy-search and attach project files in editor)
|skills(on-demand · loaded when task matches description)

## Providers

|oauth:{Anthropic Claude,OpenAI ChatGPT,GitHub Copilot,Google Gemini CLI,Google Antigravity}
|api-keys:{Anthropic,OpenAI,Azure OpenAI,Google Gemini,Google Vertex,Amazon Bedrock,Mistral,Groq,Cerebras,xAI,OpenRouter,Vercel AI Gateway,ZAI,OpenCode Zen,OpenCode Go,Hugging Face,Kimi For Coding,MiniMax}
|custom: models.json or pi.registerProvider() in extensions · OpenAI/Anthropic/Google API formats + custom streaming
|docs:{docs/providers.md,docs/models.md,docs/custom-provider.md}

## Interactive Features

|@(file references · fuzzy-search project files)|Tab(path completion)|Ctrl+V(image paste)
|!/!!(bash · run shell, optionally send output to LLM)|Ctrl+P(model cycling)|Shift+Tab(thinking levels: off→minimal→low→medium→high→xhigh)
|Ctrl+O(tool output toggle)|Ctrl+G(external editor · $VISUAL/$EDITOR)|keybindings.json(57 rebindable actions)
|doc:docs/keybindings.md

## Settings

|42 options: model/thinking, UI/display, compaction, retry, message delivery, terminal, shell, resource paths
|locations:{~/.pi/agent/settings.json(global),.pi/settings.json(project overrides global)}
|doc:docs/settings.md

## SDK & Programmatic Use

|createAgentSession()(embed agent loop → docs/sdk.md)
|SessionManager(create, open, list, fork sessions → docs/sdk.md#session-management)
|DefaultResourceLoader(discover/override extensions, skills, prompts, themes, context → docs/sdk.md#resourceloader)
|InteractiveMode(full TUI from SDK → docs/sdk.md#interactivemode)
|runPrintMode(single-shot from SDK → docs/sdk.md#runprintmode)
|runRpcMode(RPC from SDK → docs/sdk.md#runrpcmode)
|tool-factories:createReadTool(cwd) etc. for custom working dirs → docs/sdk.md#tools-with-custom-cwd
|12 examples in examples/sdk/

## Package System

|pi install npm:@foo/bar|pi install git:github.com/u/r|pi install ./local/path
|pi list|pi update(non-pinned)|pi config(enable/disable resources)|-l for project-local
|doc:docs/packages.md

## Doc Index — 23 files in docs/

|extensions.md(Extension API, events, tools, UI, rendering)|sdk.md(programmatic embedding, AgentSession, tools)
|rpc.md(JSON protocol for headless integration)|session.md(JSONL format, entry types, SessionManager API)
|compaction.md(auto-compaction, branch summarization)|tui.md(TUI component API for extensions)
|themes.md(theme format, color tokens)|skills.md(skill structure, Agent Skills standard)
|prompt-templates.md(reusable prompts with arguments)|packages.md(package creation, install, filtering)
|keybindings.md(keyboard shortcuts, customization)|settings.md(all settings reference)
|providers.md(provider setup · API keys, OAuth)|models.md(custom models via models.json)
|custom-provider.md(custom provider API, OAuth, streaming)|tree.md(session tree navigation)
|json.md(JSON output mode)|shell-aliases.md(shell alias setup)
|terminal-setup.md(terminal configuration)|tmux.md(tmux integration)
|development.md(contributing, forking, debugging)|windows.md(Windows setup)|termux.md(Android/Termux setup)
