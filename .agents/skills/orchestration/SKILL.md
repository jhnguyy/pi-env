---
name: orchestration
description: Subagent spawning, scoping, and context gathering. Use when decomposing tasks into scoped subagent work, gathering project context before implementation, or coordinating multi-step workflows across subagents.
---

# Orchestration

## Mental Model

**Goal:** Route context to scoped workers, wait for completion signals, and synthesize results into a coherent output. Workers do bounded work and report back.

`gather context → dispatch workers (parallel or coordinating) → wait → synthesize → cleanup → commit`

**Tool guidance:**

| Situation | Tool |
|---|---|
| Multi-agent orchestration with code changes | `orch` — handles ORCH_DIR, bus session, worktrees, env injection, cleanup, receipts |
| Multi-agent orchestration without code changes | `orch` (omit `repo`) — same lifecycle guarantees, no worktrees |
| Single persistent service or long-running pane | `tmux` directly |
| Single standalone pane (not part of a run) | `tmux` directly |
| Completion signaling | `bus wait` — event-driven, no polling |
| Debugging a stalled pane | `tmux read` |

> **This skill is a living document.** When you discover a pattern that works better — update it.

---

## Orch Flow

```
orch start { repo: "/path/to/repo" }   // → runId, orchDir, busSession (set as PI_BUS_SESSION)

orch spawn { label: "scout-a", command: "pi --no-session ...", busChannel: "scouts:a" }
orch spawn { label: "scout-b", command: "pi --no-session ...", busChannel: "scouts:b" }
// Each worker gets: isolated worktree, own branch (orch/<runId>/<label>),
// PI_BUS_SESSION + PI_AGENT_ID injected, bus exit shim for crash-safe signaling.

bus wait { channels: ["scouts:a", "scouts:b"] }
bus read { channel: "scouts:a" }
bus read { channel: "scouts:b" }

read { path: "$ORCH_DIR/scout-a.json" }   // workers write results to ORCH_DIR

// ... synthesize, spawn builders if needed, repeat ...

orch cleanup {}
// → kills panes, removes worktrees, deletes ORCH_DIR, writes run receipt.
// Branches are preserved: git branch --list 'orch/*' to review.
// Run receipt in /tmp/orch-runs/ for retrospectives.
```

**Cleanup is required.** `orch cleanup` is the final step of every orchestration — not optional, not conditional. If the session ends before cleanup, `orch status` shows the uncleaned run; clean up in the next session.

---

## Scoping Workers

**Least privilege** — give each worker only the tools, skills, and context its task requires.

| Flag | Effect |
|---|---|
| `--tools read,bash` | Restrict to specific tools |
| `--no-skills` | No skill injection — clean context |
| `--no-extensions` | No extension hooks — no permission gates |
| `--skills a,b` | Specific skills only |
| `--append-system-prompt "..."` | Add constraints, keep defaults |

**Model selection** — run `pi --list-models` for current IDs; pass full ID, not alias. Match capability to what the task genuinely requires.

**Prompt framing** — lead with the goal and what good output looks like. Instruct workers to write results to `$ORCH_DIR/<label>.json` and publish to their bus channel when done.

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

Pass `busChannel` to `orch spawn` — the exit shim auto-publishes when the pane exits, regardless of how (clean exit, crash, timeout). Per-worker channels enable partial-failure recovery.

```
// Wait for both; re-wait if only one arrives
bus wait { channels: ["scouts:a", "scouts:b"], timeout: 300 }
msgs_a = bus read { channel: "scouts:a" }
msgs_b = bus read { channel: "scouts:b" }
// if msgs_b is empty → bus wait again on ["scouts:b"]
```

Workers publish from inside their prompt: `"When done, publish to channel 'scouts:a' with a summary."`

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
- **Crashed worker:** re-spawn that label only — `orch spawn { label: "scout-a", ... }` again.

---

## Multi-Agent Dialogue

For design decisions requiring genuine back-and-forth. Spawn agents on a shared bus channel and let them exchange positions. No persona prompts — give each agent the same material and different context emphasis.

What makes it work: agents reason with evidence, stay on one topic until resolved, surface disagreement explicitly. If two exchanges don't produce movement, bring both positions to the human — persistent disagreement is usually about values, not facts.

**Model selection:** Sonnet ↔ Sonnet for known solution space; Sonnet ↔ Opus for genuine uncertainty or high-stakes architecture.

---

## Boundaries

Invocation mechanics, orchestration patterns, multi-agent dialogue. Not covered: domain skill content, safety enforcement, session handoffs (see handoff skill).
