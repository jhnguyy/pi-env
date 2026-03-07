---
name: orchestration
description: Subagent spawning, scoping, and context gathering. Use when decomposing tasks into scoped subagent work, gathering project context before implementation, or coordinating multi-step workflows across subagents.
---

# Orchestration

## Mental Model

**Goal:** Route context to scoped workers, wait for completion signals, and synthesize results into a coherent output. Workers do bounded work and report back. Workers can coordinate directly with each other when the exchange is well-scoped and self-contained — route through the orchestrator when its output determines what gets spawned next, or when you need to filter before passing downstream.

`gather context → dispatch workers (parallel or coordinating) → wait → synthesize → cleanup → commit`

**Tool guidance:**

| Situation | Tool |
|---|---|
| Multi-agent orchestration with code changes | `orch` — handles ORCH_DIR, bus session, worktrees, env injection, cleanup, receipts |
| Multi-agent orchestration without code changes | `orch` (omit `repo`) — same lifecycle guarantees, no worktrees |
| Single persistent service or long-running pane | `tmux` directly (set `PI_BUS_SESSION` and `PI_AGENT_ID` manually) |
| Single standalone pane (not part of a run) | `tmux` directly |
| Completion signaling | `bus wait` — event-driven, no polling |
| Debugging a stalled pane | `tmux read` |

> **Anti-pattern:** `sleep 30 && tmux read ...` — polling. Use `bus wait` instead.

> **This skill is a living document.** When you discover a pattern that works better — update it.

---

## Orch Flow

```
orch start { repo: "/path/to/repo" }   // → runId, orchDir, busSession (PI_BUS_SESSION set)

orch spawn { label: "scout-a", command: "pi --no-session ...", busChannel: "scouts:a" }
orch spawn { label: "scout-b", command: "pi --no-session ...", busChannel: "scouts:b" }
// Each worker gets: isolated worktree, own branch (orch/<runId>/<label>),
// PI_BUS_SESSION, PI_AGENT_ID, and ORCH_DIR injected into env,
// bus exit shim for crash-safe signaling.

bus wait { channels: ["scouts:a", "scouts:b"] }
bus read { channel: "scouts:a" }         // wakes on first; re-wait if second not yet
bus read { channel: "scouts:b" }

read { path: "<orchDir>/scout-a.json" }  // workers write results to $ORCH_DIR
read { path: "<orchDir>/scout-b.json" }
// distill before passing to builders

// Phase 2 — builders (parallel, using scout output)
orch spawn { label: "builder-a", command: "pi --no-session @<orchDir>/scout-a.json ...", busChannel: "builders:a" }
orch spawn { label: "builder-b", command: "pi --no-session @<orchDir>/scout-b.json ...", busChannel: "builders:b" }

bus wait { channels: ["builders:a", "builders:b"] }
bus read { channel: "builders:a" }
bus read { channel: "builders:b" }

// verify → merge branches → orch cleanup
orch cleanup {}
// → kills panes, removes worktrees, deletes ORCH_DIR, writes run receipt.
// Branches are preserved: git branch --list 'orch/*' to review.
// Run receipt in /tmp/orch-runs/ for retrospectives.
```

**Cleanup is required.** `orch cleanup` is the final step of every orchestration — not optional, not conditional. If the session ends before cleanup, the shutdown hook logs a warning visible in the TUI and `orch status` shows the uncleaned run; clean up in the next session.

---

## Scoping Workers

**Least privilege** — give each worker only the tools, skills, and context its task requires. Instruct workers to report findings and changes only, no reasoning or summaries.

| Flag | Effect |
|---|---|
| `--tools read,bash` | Restrict to specific tools |
| `--no-skills` | No skill injection — clean context |
| `--no-extensions` | No extension hooks — no permission gates |
| `--skills a,b` | Specific skills only |
| `--append-system-prompt "..."` | Add constraints, keep defaults |

**Role contracts** are behavioral specifications in `~/.agents/roles/` injected via `--append-system-prompt @~/.agents/roles/scout.md`. Available: `orchestrator.md`, `scout.md`, `worker.md`, `reviewer.md`. Use to specify what the agent reports, its scope, and what it doesn't do.

**Prompt framing** — lead with the goal and what good output looks like. Give each worker different context emphasis rather than a different persona. For complex tasks, write a brief (`write { path: '$ORCH_DIR/brief-a.md' }`) and pass via `@file` — keeps prompts short, lets multiple workers share context.

**Model selection** — run `pi --list-models` for current IDs; pass full ID, not alias. Match capability to what the task genuinely requires.

**Env vars:** `orch spawn` auto-injects `PI_BUS_SESSION`, `PI_AGENT_ID`, and `ORCH_DIR`. If spawning via `tmux` directly (outside an `orch` run), you must set `PI_BUS_SESSION` and `PI_AGENT_ID` manually or `bus publish` will silently fail.

---

## Dispatch

Spawn all independent workers before waiting on any. Sequential dispatch only when a worker's output is required to form the next worker's prompt.

```
orch spawn worker-a
orch spawn worker-b
bus wait for both → synthesize → orch spawn worker-c if needed
```

---

## Completion Signaling

Pass `busChannel` to `orch spawn` — the exit shim auto-publishes `{"message": "process exited"}` when the pane exits, regardless of how (clean exit, crash, timeout). Per-worker channels enable partial-failure recovery.

```
// Wait for both; re-wait if only one arrives
bus wait { channels: ["scouts:a", "scouts:b"], timeout: 300 }
msgs_a = bus read { channel: "scouts:a" }
msgs_b = bus read { channel: "scouts:b" }
// if msgs_b is empty → bus wait again on ["scouts:b"]
```

Workers also publish from inside their prompt: `"When done, publish to channel 'scouts:a' with a summary."` — this carries the structured result; the exit shim is the crash-safe fallback.

---

## Data Flow

**Files carry data. Bus carries signals.** Workers write results to `$ORCH_DIR/<label>.json` and publish completion to their bus channel. Read files for content; wait on bus for timing. Synthesize before passing downstream — never relay verbatim.

---

## Debugging Stalled Workers

`tmux read` is for diagnosis only — not completion detection.

When `bus wait` times out:
1. `tmux read { paneId: "..." }` — see what's on screen
2. Common causes: permission gate (approve with `tmux send`), silent crash, wrong `PI_BUS_SESSION`
3. Use `--no-extensions` in worker command to prevent permission gates entirely
4. Fix and re-spawn the failed worker only; don't re-run the whole pipeline

**Note:** Labels are unique within a run — to re-spawn a crashed worker with the same label, use a suffix (e.g., `scout-a-retry`).

---

## Tmux Scenarios (outside orch)

For single panes that aren't part of a multi-agent orchestration:

| Scenario | Flag |
|---|---|
| User wants real-time visibility | `interactive: true` — full TUI |
| Persistent service | `interactive: true` |
| Keep output visible after exit | `waitOnExit: true` |
| Crash-safe completion signal | `busChannel: "channel-name"` |
| Quick ephemeral worker | `pi -p` directly (no tmux) |

---

## Context Gathering

Before implementation, gather with a cheap read-only scout (does not need `orch`):

```bash
pi --no-session --tools read,bash --no-skills --model claude-haiku-4-5 \
  "Analyze this repo for: [TASK]. Report only:
   1. Stack and toolchain  2. Exact build/test/lint commands
   3. Files relevant to the task  4. Conventions that constrain implementation
   No summaries. Structured output only. Write to /tmp/scout-context.json."
```

Extract: stack → skills to load; commands → pass verbatim to workers; paths → `@file` args; conventions → `--append-system-prompt`.

---

## Error Handling

- **Before retrying:** adjust prompt, scoping, or file args — identical retries produce identical failures.
- **Broken tests:** spawn a focused fix worker with test output + relevant files, not a full re-run.
- **Stalled pane:** `tmux read` to diagnose; `--no-extensions` to prevent permission gates.
- **Crashed worker:** re-spawn with a new label suffix (e.g., `scout-a-retry`). Labels must be unique within a run.

---

## Multi-Agent Dialogue

For design decisions requiring genuine back-and-forth. Spawn agents on a shared bus channel and let them exchange positions. No persona prompts — give each agent the same material and different context emphasis.

What makes it work: agents reason with evidence, stay on one topic until resolved, surface disagreement explicitly. If two exchanges don't produce movement, bring both positions to the human — persistent disagreement is usually about values, not facts.

**Model selection:** Sonnet ↔ Sonnet for known solution space; Sonnet ↔ Opus for genuine uncertainty or high-stakes architecture.

---

## Boundaries

Invocation mechanics, orchestration patterns, multi-agent dialogue. Not covered: domain skill content, safety enforcement, session handoffs (see handoff skill).
