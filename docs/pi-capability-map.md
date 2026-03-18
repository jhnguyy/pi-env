# Pi Capability Map

> **Auto-generated from pi v0.60.0** — run `bash scripts/generate-capability-map.sh` after version bumps.
> This is a navigation aid, not a replacement for the docs. Each section links to the authoritative source.

## What This Is

A structured index of pi's capabilities for agents and users who need breadth-first orientation. When you know *what* you want to do but not *where* to look, start here. When you need *how*, follow the doc links.

---

## Modes of Operation

| Mode | Flag | Use Case | Doc |
|------|------|----------|-----|
| Interactive | *(default)* | Full TUI with editor, commands, shortcuts | [README](../node_modules/@mariozechner/pi-coding-agent/README.md) |
| Print | `-p` / `--print` | Single-shot: prompt → response → exit | [README](../node_modules/@mariozechner/pi-coding-agent/README.md#programmatic-usage) |
| JSON | `--mode json` | Stream all events as JSONL | [json.md](../node_modules/@mariozechner/pi-coding-agent/docs/json.md) |
| RPC | `--mode rpc` | Headless JSON protocol over stdin/stdout | [rpc.md](../node_modules/@mariozechner/pi-coding-agent/docs/rpc.md) |
| SDK | *(TypeScript)* | Embed `AgentSession` in your own app | [sdk.md](../node_modules/@mariozechner/pi-coding-agent/docs/sdk.md) |

---

## Built-in Tools

Default set: `read`, `bash`, `edit`, `write`. Additional: `grep`, `find`, `ls`.

Enable specific tools with `--tools read,bash,grep`. Disable all with `--no-tools`. Extensions can override or add tools.

---

## Customization System

Pi is extended through four resource types, all shareable via [Pi Packages](../node_modules/@mariozechner/pi-coding-agent/docs/packages.md):

### Extensions — TypeScript modules that extend pi at runtime
- **Custom tools** — register tools the LLM can call (`pi.registerTool()`)
- **Event interception** — block/modify tool calls, inject context, customize compaction (~56 event types)
- **Custom commands** — `/mycommand` via `pi.registerCommand()`
- **Custom keyboard shortcuts** — `pi.registerShortcut()`
- **Custom UI** — TUI components, widgets, overlays, status lines, footers, custom editors
- **Session persistence** — store state that survives restarts (`pi.appendEntry()`)
- **Custom rendering** — control how tool calls/results display
- **Custom providers** — add model providers with OAuth support (`pi.registerProvider()`)
- **Dynamic tools** — register/unregister tools at runtime, toggle active set
- **Remote execution** — pluggable operations for SSH, containers, sandboxes
- **Custom compaction** — replace the summarization strategy
- **Input transformation** — rewrite user input before processing
- **Inter-extension events** — `pi.events` shared bus

  **Locations:** `~/.pi/agent/extensions/` (global), `.pi/extensions/` (project), settings, CLI `-e`
  **Doc:** [extensions.md](../node_modules/@mariozechner/pi-coding-agent/docs/extensions.md) — 66 working examples in [examples/extensions/](../node_modules/@mariozechner/pi-coding-agent/examples/extensions/)

### Skills — On-demand instruction packages ([Agent Skills standard](https://agentskills.io))
- Progressive disclosure: descriptions always in context, full instructions loaded on demand
- Invoked via `/skill:name` or automatically by the agent when task matches description
- Can include scripts, references, and assets alongside SKILL.md
- Compatible with Claude Code and OpenAI Codex skill directories

  **Locations:** `~/.pi/agent/skills/`, `~/.agents/skills/`, `.pi/skills/`, `.agents/skills/` (walks up to git root), settings, CLI
  **Doc:** [skills.md](../node_modules/@mariozechner/pi-coding-agent/docs/skills.md)

### Prompt Templates — Reusable prompt snippets as Markdown files
- Expand via `/name` in editor
- Support positional arguments (`$1`, `$@`, `${@:N}`)
- Can include frontmatter with description

  **Locations:** `~/.pi/agent/prompts/`, `.pi/prompts/`, settings, CLI
  **Doc:** [prompt-templates.md](../node_modules/@mariozechner/pi-coding-agent/docs/prompt-templates.md)

### Themes — JSON color definitions for the TUI
- 55 color tokens covering UI, markdown, syntax, diffs, thinking levels
- Hot-reload: edit active theme file → instant update
- Variable system for reusable color palettes
- Built-in: `dark`, `light`

  **Locations:** `~/.pi/agent/themes/`, `.pi/themes/`, settings, CLI
  **Doc:** [themes.md](../node_modules/@mariozechner/pi-coding-agent/docs/themes.md)

---

## Session System

| Feature | Description | Doc |
|---------|-------------|-----|
| Tree-structured history | Entries linked by id/parentId; branch in-place without new files | [session.md](../node_modules/@mariozechner/pi-coding-agent/docs/session.md) |
| `/tree` navigation | Navigate to any point, optionally summarize abandoned branch | [tree.md](../node_modules/@mariozechner/pi-coding-agent/docs/tree.md) |
| `/fork` | Extract current branch to a new session file | [README](../node_modules/@mariozechner/pi-coding-agent/README.md#branching) |
| Auto-compaction | Summarizes old messages when context approaches limit | [compaction.md](../node_modules/@mariozechner/pi-coding-agent/docs/compaction.md) |
| Branch summarization | Preserves context when switching branches via `/tree` | [compaction.md](../node_modules/@mariozechner/pi-coding-agent/docs/compaction.md#branch-summarization) |
| Labels/bookmarks | Mark entries for `/tree` navigation (`pi.setLabel()`) | [session.md](../node_modules/@mariozechner/pi-coding-agent/docs/session.md#labelentry) |
| Session naming | Display names for session picker (`/name`, `pi.setSessionName()`) | [session.md](../node_modules/@mariozechner/pi-coding-agent/docs/session.md#sessioninfoentry) |
| Message queue | Steer (interrupt) or follow-up (wait) while agent works | [README](../node_modules/@mariozechner/pi-coding-agent/README.md#message-queue) |

---

## Context System

| Source | Scope | Description |
|--------|-------|-------------|
| `AGENTS.md` / `CLAUDE.md` | Global + project (walks up from cwd) | Project instructions, conventions |
| `SYSTEM.md` | Global or project | Replace default system prompt |
| `APPEND_SYSTEM.md` | Global or project | Append to system prompt without replacing |
| `@file` references | Per-message | Fuzzy-search and attach project files in editor |
| Skills | On-demand | Loaded when task matches description |

---

## Provider Support

**Subscriptions (OAuth):** Anthropic Claude, OpenAI ChatGPT, GitHub Copilot, Google Gemini CLI, Google Antigravity

**API Keys:** Anthropic,OpenAI,Azure OpenAI,Google Gemini,Google Vertex,Amazon Bedrock,Mistral,Groq,Cerebras,xAI,OpenRouter,Vercel AI Gateway,ZAI,OpenCode Zen,OpenCode Go,Hugging Face,Kimi For Coding,MiniMax

**Custom:** Add providers via `models.json` or `pi.registerProvider()` in extensions. Supports OpenAI, Anthropic, and Google API formats plus custom streaming.

**Doc:** [providers.md](../node_modules/@mariozechner/pi-coding-agent/docs/providers.md), [models.md](../node_modules/@mariozechner/pi-coding-agent/docs/models.md), [custom-provider.md](../node_modules/@mariozechner/pi-coding-agent/docs/custom-provider.md)

---

## Interactive Features

| Feature | How | Description |
|---------|-----|-------------|
| File references | `@` in editor | Fuzzy-search project files |
| Path completion | Tab | Complete file paths |
| Image paste | Ctrl+V | Send images to LLM |
| Bash commands | `!` / `!!` | Run shell, optionally send output to LLM |
| Model cycling | Ctrl+P | Cycle through scoped models |
| Thinking levels | Shift+Tab | off → minimal → low → medium → high → xhigh |
| Tool output toggle | Ctrl+O | Collapse/expand tool output |
| External editor | Ctrl+G | Open input in $VISUAL/$EDITOR |
| Customizable keys | `keybindings.json` | 57 rebindable actions |

**Doc:** [keybindings.md](../node_modules/@mariozechner/pi-coding-agent/docs/keybindings.md)

---

## Settings

42 configurable options across: model/thinking, UI/display, compaction, retry, message delivery, terminal, shell, and resource paths.

**Locations:** `~/.pi/agent/settings.json` (global), `.pi/settings.json` (project overrides global)

**Doc:** [settings.md](../node_modules/@mariozechner/pi-coding-agent/docs/settings.md)

---

## SDK & Programmatic Use

| Entry Point | Description | Doc |
|-------------|-------------|-----|
| `createAgentSession()` | Embed agent loop in your app | [sdk.md](../node_modules/@mariozechner/pi-coding-agent/docs/sdk.md) |
| `SessionManager` | Create, open, list, fork sessions programmatically | [sdk.md](../node_modules/@mariozechner/pi-coding-agent/docs/sdk.md#session-management) |
| `DefaultResourceLoader` | Discover/override extensions, skills, prompts, themes, context | [sdk.md](../node_modules/@mariozechner/pi-coding-agent/docs/sdk.md#resourceloader) |
| `InteractiveMode` | Full TUI mode from SDK | [sdk.md](../node_modules/@mariozechner/pi-coding-agent/docs/sdk.md#interactivemode) |
| `runPrintMode` | Single-shot mode from SDK | [sdk.md](../node_modules/@mariozechner/pi-coding-agent/docs/sdk.md#runprintmode) |
| `runRpcMode` | RPC mode from SDK | [sdk.md](../node_modules/@mariozechner/pi-coding-agent/docs/sdk.md#runrpcmode) |
| Tool factories | `createReadTool(cwd)`, etc. for custom working dirs | [sdk.md](../node_modules/@mariozechner/pi-coding-agent/docs/sdk.md#tools-with-custom-cwd) |

12 SDK examples in [examples/sdk/](../node_modules/@mariozechner/pi-coding-agent/examples/sdk/)

---

## Package System

Install and share bundles of extensions, skills, prompts, and themes:

```bash
pi install npm:@foo/bar          # From npm
pi install git:github.com/u/r    # From git (HTTPS or SSH)
pi install ./local/path          # Local directory
pi list                          # Show installed
pi update                        # Update non-pinned
pi config                        # Enable/disable resources
```

**Doc:** [packages.md](../node_modules/@mariozechner/pi-coding-agent/docs/packages.md)

---

## Quick Reference: Doc Index

All 23 doc files in `node_modules/@mariozechner/pi-coding-agent/docs/`:

| Doc | Topic |
|-----|-------|
| [extensions.md](../node_modules/@mariozechner/pi-coding-agent/docs/extensions.md) | Extension API, events, tools, UI, rendering |
| [sdk.md](../node_modules/@mariozechner/pi-coding-agent/docs/sdk.md) | Programmatic embedding, AgentSession, tools |
| [rpc.md](../node_modules/@mariozechner/pi-coding-agent/docs/rpc.md) | JSON protocol for headless integration |
| [session.md](../node_modules/@mariozechner/pi-coding-agent/docs/session.md) | JSONL format, entry types, SessionManager API |
| [compaction.md](../node_modules/@mariozechner/pi-coding-agent/docs/compaction.md) | Auto-compaction, branch summarization |
| [tui.md](../node_modules/@mariozechner/pi-coding-agent/docs/tui.md) | TUI component API for extensions |
| [themes.md](../node_modules/@mariozechner/pi-coding-agent/docs/themes.md) | Theme format, color tokens |
| [skills.md](../node_modules/@mariozechner/pi-coding-agent/docs/skills.md) | Skill structure, Agent Skills standard |
| [prompt-templates.md](../node_modules/@mariozechner/pi-coding-agent/docs/prompt-templates.md) | Reusable prompts with arguments |
| [packages.md](../node_modules/@mariozechner/pi-coding-agent/docs/packages.md) | Package creation, install, filtering |
| [keybindings.md](../node_modules/@mariozechner/pi-coding-agent/docs/keybindings.md) | Keyboard shortcuts, customization |
| [settings.md](../node_modules/@mariozechner/pi-coding-agent/docs/settings.md) | All settings reference |
| [providers.md](../node_modules/@mariozechner/pi-coding-agent/docs/providers.md) | Provider setup (API keys, OAuth) |
| [models.md](../node_modules/@mariozechner/pi-coding-agent/docs/models.md) | Custom models via models.json |
| [custom-provider.md](../node_modules/@mariozechner/pi-coding-agent/docs/custom-provider.md) | Custom provider API, OAuth, streaming |
| [tree.md](../node_modules/@mariozechner/pi-coding-agent/docs/tree.md) | Session tree navigation |
| [json.md](../node_modules/@mariozechner/pi-coding-agent/docs/json.md) | JSON output mode |
| [shell-aliases.md](../node_modules/@mariozechner/pi-coding-agent/docs/shell-aliases.md) | Shell alias setup |
| [terminal-setup.md](../node_modules/@mariozechner/pi-coding-agent/docs/terminal-setup.md) | Terminal configuration |
| [tmux.md](../node_modules/@mariozechner/pi-coding-agent/docs/tmux.md) | tmux integration |
| [development.md](../node_modules/@mariozechner/pi-coding-agent/docs/development.md) | Contributing, forking, debugging |
| [windows.md](../node_modules/@mariozechner/pi-coding-agent/docs/windows.md) | Windows-specific setup |
| [termux.md](../node_modules/@mariozechner/pi-coding-agent/docs/termux.md) | Android/Termux setup |
