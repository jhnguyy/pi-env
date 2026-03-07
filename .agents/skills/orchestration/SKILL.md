---
name: orchestration
description: Subagent spawning, scoping, and context gathering. Use when decomposing tasks into scoped subagent work, gathering project context before implementation, or coordinating multi-step workflows across subagents.
---

# Orchestration

## Mental Model

**Goal:** Route context to scoped workers, wait for completion signals, and synthesize results into a coherent output. Workers do bounded work and report back. Workers can coordinate directly with each other when the exchange is well-scoped and self-contained — route through the orchestrator when its output determines what gets spawned next, or when you need to filter before passing downstream.

`gather context → dispatch workers (parallel or coordinating) → wait → synthesize → repeat or commit`

**Tool guidance — reason about the situation; these are defaults, not rules:**

| Tool | Strongest at | Notes |
|------|--------------|-------|
| `tmux` | Process management — spawn workers, send keystrokes, observe output | Completion detection via `tmux read` is fragile; prefer `bus` when you can |
| `bus` | Event-driven completion signaling — no polling, crash-safe exits | Can also carry small data payloads; direct worker-to-worker coordination works when no orchestrator routing is needed |
| `tmux read` | Diagnosing stalled panes, reading permission prompts | Useful for any "what is on screen right now" question, not just debugging |

> **This skill is a living document.** When you discover a pattern that works better than what's described here — update the skill. Better patterns beat prescribed ones. Note the context so future agents know when to apply each approach.

---

## Spawning Workers

`--no-session` = ephemeral (no session persistence). Pass `interactive: true` to `tmux run` so the full TUI renders in the pane — the user can follow tool calls and progress in real time.

```bash
pi --no-session "prompt"
pi --no-session @src/main.ts @package.json "Review this module"
```

For complex tasks, write a brief (`write { path: '/tmp/brief.md', content: '...' }`) and pass via `@file` — keeps prompts short, lets multiple workers share context. Clean up temp files after workers complete.

**Prompt framing** — lead with the goal and what good output looks like. Give each worker different context emphasis rather than a different persona.

---

## Scoping

**Least privilege** — give each worker only the tools, skills, and context its task requires. Each worker gets only what its task needs; instruct workers to report findings and changes only, no reasoning or summaries.

| Flag | Effect |
|---|---|
| `--tools read,bash` | Restrict to specific tools |
| `--no-skills` | No skill injection — clean context |
| `--no-extensions` | No extension hooks — no permission gates |
| `--skills a,b` | Specific skills only |
| `--system-prompt "..."` | Override default system prompt |
| `--append-system-prompt "..."` | Add constraints, keep defaults |

**Model selection** — run `pi --list-models` to get current IDs; pass the full ID, not a short alias. Match capability to what the task genuinely requires: deeper reasoning, adversarial analysis, or catching subtle failure modes warrant a stronger model; well-scoped or mechanical tasks do not.

---

## Dispatch

Spawn all independent workers before waiting on any of them. Dispatch sequentially only when a worker's output is required to form the next worker's prompt.

```
spawn worker-a
spawn worker-b
wait for both → synthesize → spawn worker-c
```

---

## Completion Signaling (Bus)

Event-driven. No polling. No sleep loops. `bus` is a core pi tool — unaffected by `--no-extensions`.

```
bus start { agentId: "orch" }   // → session id
```

Spawn workers with the session ID **and agent ID**; instruct them in natural language to publish when done:
```bash
PI_BUS_SESSION=<id> PI_AGENT_ID=<label> pi -p --no-session "...task... When done, publish to channel 'phase-1' with a summary."
```

`PI_AGENT_ID` is required for workers to call `bus publish`. Without it, the publish call silently fails with "No agent ID". Use the worker's label as the ID (e.g. `PI_AGENT_ID=scout-a`).

`bus wait` wakes on **at least one new message** on any listed channel. `bus read` returns all messages since last read:
```
bus wait { channels: ["phase-1"], timeout: 300 }
msgs = bus read { channel: "phase-1" }
// msgs.length < N → wait again
```

For N parallel workers, use per-worker channels to avoid ambiguity and enable partial-failure recovery (re-spawn only failed workers):
```
bus wait { channels: ["phase:scout-a", "phase:scout-b"] }
// each worker prompt: "publish to channel 'phase:scout-a' when done" (unique per worker)
```

**Crash-safe signaling** — use `busChannel` on `tmux run` to publish an exit signal even if the worker crashes before its own publish call:
```
tmux run { label: "scout-a", command: "PI_BUS_SESSION=<id> pi ...", busChannel: "scouts:a" }
```
The pane publishes `{"message": "process exited"}` to `scouts:a` when the process terminates, regardless of how it exits.

### Anti-pattern
```bash
sleep 30 && tmux read ...   # polling — use bus wait instead
```

---

## Data Flow

**Files carry data. Bus carries signals.** Workers write results to files and publish completion to the bus. Coordinator reads files for content, waits on the bus for timing. Do not forward raw worker output downstream — distill to what the next phase needs. Synthesize results into a coherent response; never relay verbatim.

---

## Debugging Stalled Workers (tmux read)

`tmux read` is for diagnosis only — not completion detection.

When `bus wait` times out:
1. `tmux read { paneId: "..." }` — see what's on screen
2. Common causes: permission gate (approve with `tmux send`), silent crash, wrong `PI_BUS_SESSION`
3. Fix and re-spawn the failed worker only; don't re-run the whole pipeline

```
tmux run { label: "worker-a", ..., busChannel: "workers:a" }
bus wait { channels: ["workers:a"], timeout: 120 }
// timeout → check what happened
tmux read { paneId: "<id>" }           // see current screen
tmux send { paneId: "<id>", text: "y" }  // approve a permission gate
```

To prevent permission gates entirely: `--no-extensions` in the worker command.

---

## Context Gathering

Before implementation, gather with a cheap read-only scout:

```bash
pi --no-session --tools read,bash --no-skills --model claude-haiku-4-5 \
  "Analyze this repo for: [TASK]. Report only:
   1. Stack and toolchain  2. Exact build/test/lint commands
   3. Files relevant to the task  4. Conventions that constrain implementation
   No summaries. Structured output only."
```

Extract: stack → skills to load; commands → pass verbatim to workers; paths → `@file` args; conventions → `--append-system-prompt`.

---

## Error Handling

- **Before retrying:** adjust prompt, scoping, or file args — identical retries produce identical failures.
- **Broken tests:** spawn a focused fix worker with test output + relevant files, not a full re-run.
- **Contradictory output:** re-gather that specific area before proceeding.
- **Stalled pane:** `tmux read` to diagnose; `--no-extensions` to prevent permission gates.

---

## Tmux for Long-Running Work

| Scenario | Flag |
|---|---|
| User wants real-time visibility | `interactive: true` — full TUI |
| Persistent service | `interactive: true` |
| Keep output visible after exit | `waitOnExit: true` |
| Crash-safe completion signal | `busChannel: "channel-name"` |
| Quick ephemeral worker | `pi -p` directly |

`tmux run` returns a `paneId` — required for subsequent calls:
```
paneId = tmux run { command: "pi --no-session '...'", label: "impl", interactive: true }
tmux send { paneId: "<id>", text: "y" }    // approve a blocked prompt
tmux close { paneId: "<id>", kill: true }  // kill: false deregisters without terminating
```

---

## End-to-End Example

All `bus *` / `tmux *` / `read *` are **pi tool calls**.

```
bus start { agentId: "orch" }   // → session: "abc123"

// Scouts — parallel, per-worker channels, busChannel for crash-safety
tmux run { label: "scout-a", busChannel: "scouts:a", interactive: true,
  command: "PI_BUS_SESSION=abc123 PI_AGENT_ID=scout-a pi --no-session --tools read,bash --no-extensions \
  'Analyze X. Write to /tmp/scout-a.json. Publish to channel scouts:a when done.'" }
tmux run { label: "scout-b", busChannel: "scouts:b", interactive: true,
  command: "PI_BUS_SESSION=abc123 PI_AGENT_ID=scout-b pi --no-session --tools read --no-extensions \
  'Analyze Y. Write to /tmp/scout-b.md. Publish to channel scouts:b when done.'" }

bus wait { channels: ["scouts:a", "scouts:b"] }   // wakes on first; loop if second not yet read
bus read { channel: "scouts:a" }
bus read { channel: "scouts:b" }

read { path: "/tmp/scout-a.json" }   // distill before passing to builders
read { path: "/tmp/scout-b.md" }

// Builders — parallel, per-worker channels
tmux run { label: "builder-a", busChannel: "builders:a", interactive: true,
  command: "PI_BUS_SESSION=abc123 PI_AGENT_ID=builder-a pi --no-session --tools read,write,bash --no-extensions \
  @/tmp/scout-a.json 'Implement A. Publish to channel builders:a when done.'" }
tmux run { label: "builder-b", busChannel: "builders:b", interactive: true,
  command: "PI_BUS_SESSION=abc123 PI_AGENT_ID=builder-b pi --no-session --tools read,write --skills skill-builder --no-extensions \
  @/tmp/scout-b.md 'Write skill B. Publish to channel builders:b when done.'" }

bus wait { channels: ["builders:a", "builders:b"] }
bus read { channel: "builders:a" }
bus read { channel: "builders:b" }
// verify → commit → rm /tmp/scout-*.json /tmp/scout-*.md
```

---

## Multi-Agent Dialogue

For design decisions requiring genuine back-and-forth. Spawn agents on a shared bus channel and let them exchange positions. No persona prompts needed — give each agent the same material and different context emphasis (e.g. put the threat model first for one, the existing code first for another).

What makes it work: agents reason with evidence ("X because Y; Z fails because W"), stay on one topic until resolved, and surface disagreement explicitly rather than converging falsely. If two exchanges don't produce movement, bring both positions to the human — persistent disagreement is usually about values, not facts.

**Model selection:**
- Sonnet ↔ Sonnet: known solution space
- Sonnet ↔ Opus: genuine uncertainty or high-stakes architecture

---

## Boundaries

Invocation mechanics, orchestration patterns, and multi-agent dialogue. Not covered: domain skill content, safety enforcement, session management or handoffs (see handoff skill).
