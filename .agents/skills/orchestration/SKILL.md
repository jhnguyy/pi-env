---
name: orchestration
description: Subagent spawning, scoping, and context gathering. Use when decomposing tasks into scoped subagent work, gathering project context before implementation, or coordinating multi-step workflows across subagents.
---

# Orchestration

## Mental Model

You are the **coordinator**. Workers do bounded, scoped work and report results. You route context, wait for completion, and synthesize. Workers never coordinate with each other — all routing goes through you.

`gather context → dispatch workers (parallel) → wait → synthesize → repeat or commit`

**Tool role split — internalize this:**

| Tool | Role | Never use for |
|------|------|---------------|
| `tmux` | Process management — spawn, send keystrokes, observe | Completion detection |
| `bus` | Completion signaling — event-driven wait/wake | Process management |
| `tmux read` | Debugging — diagnose stalled panes, read permission gates | Checking if work is done |

---

## Spawning Workers

`-p` = non-interactive (print mode, no TUI), runs and exits. `--no-session` = ephemeral.

```bash
pi -p --no-session "prompt"
pi -p --no-session @src/main.ts @package.json "Review this module"
```

For complex tasks, write a brief (`write { path: '/tmp/brief.md', content: '...' }`) and pass via `@file` — keeps prompts short, lets multiple workers share context. Clean up temp files after workers complete.

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

**Model selection** (pi aliases; verify with `pi models`):

| Tier | Flag | Use for |
|---|---|---|
| **Haiku** | `--model claude-haiku-4-5` | Gathering, classification, read-only exploration |
| **Sonnet** | `--model claude-sonnet-4-5` | Implementation, analysis, review, skill writing |
| **Opus** | `--model claude-opus-4-5` | Complex design, novel architecture |

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
pi -p --no-session --tools read,bash --no-skills --model claude-haiku-4-5 \
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
tmux run { label: "scout-a", busChannel: "scouts:a",
  command: "PI_BUS_SESSION=abc123 PI_AGENT_ID=scout-a pi -p --no-session --tools read,bash --no-extensions \
  'Analyze X. Write to /tmp/scout-a.json. Publish to channel scouts:a when done.'" }
tmux run { label: "scout-b", busChannel: "scouts:b",
  command: "PI_BUS_SESSION=abc123 PI_AGENT_ID=scout-b pi -p --no-session --tools read --no-extensions \
  'Analyze Y. Write to /tmp/scout-b.md. Publish to channel scouts:b when done.'" }

bus wait { channels: ["scouts:a", "scouts:b"] }   // wakes on first; loop if second not yet read
bus read { channel: "scouts:a" }
bus read { channel: "scouts:b" }

read { path: "/tmp/scout-a.json" }   // distill before passing to builders
read { path: "/tmp/scout-b.md" }

// Builders — parallel, per-worker channels
tmux run { label: "builder-a", busChannel: "builders:a",
  command: "PI_BUS_SESSION=abc123 PI_AGENT_ID=builder-a pi -p --no-session --tools read,write,bash --no-extensions \
  @/tmp/scout-a.json 'Implement A. Publish to channel builders:a when done.'" }
tmux run { label: "builder-b", busChannel: "builders:b",
  command: "PI_BUS_SESSION=abc123 PI_AGENT_ID=builder-b pi -p --no-session --tools read,write --skills skill-builder --no-extensions \
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
