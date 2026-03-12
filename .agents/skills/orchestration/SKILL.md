---
name: orchestration
description: Subagent spawning, scoping, and context gathering. Use when decomposing tasks into scoped subagent work, gathering project context before implementation, or coordinating multi-step workflows across subagents.
---

# Orchestration

## Mental Model

Route context to scoped workers, wait for completion signals, synthesize results. Workers do bounded work and report back.

`gather context → dispatch workers → wait → synthesize → cleanup → commit`

| Situation | Tool |
|---|---|
| Multi-agent orchestration (with or without code) | `orch` (pass `repo` for worktree isolation) |
| Single pane / persistent service | `tmux` directly (set `PI_BUS_SESSION` and `PI_AGENT_ID` manually) |
| Completion signaling | `bus wait` — not `sleep` + `tmux read` |

---

## Orch Flow

```
orch start { repo }
orch spawn { label: "scout-a", ..., busChannel: "scouts:a" }
orch spawn { label: "scout-b", ..., busChannel: "scouts:b" }

bus wait { channels: ["scouts:a", "scouts:b"] }
// read results from $ORCH_DIR/<label>.json — distill before passing to next phase

orch spawn { label: "builder-a", ..., busChannel: "builders:a" }
bus wait → verify → merge branches → orch cleanup
```

**Cleanup is mandatory.** Always call `orch cleanup` — it kills panes, removes worktrees, writes a run receipt. Branches are preserved for review.

---

## Scoping Workers

**Least privilege** — give each worker only what its task requires.

| Flag | Effect |
|---|---|
| `--tools read,bash` | Restrict to specific tools |
| `--no-skills` | No skill injection |
| `--no-extensions` | No extension hooks / permission gates |
| `--skills a,b` | Specific skills only |
| `--append-system-prompt "..."` | Add constraints, keep defaults |

Role contracts in `~/.agents/roles/` inject via `--append-system-prompt @~/.agents/roles/scout.md`.

Lead prompts with the goal and what good output looks like. For complex tasks, write a brief to `$ORCH_DIR/brief.md` and pass via `@file`.

If spawning via `tmux` directly (outside `orch`), set `PI_BUS_SESSION` and `PI_AGENT_ID` manually or `bus publish` silently fails.

---

## Dispatch

Spawn all independent workers before waiting on any. Sequential dispatch only when a worker's output forms the next worker's prompt.

---

## Completion & Data Flow

**Files carry data. Bus carries signals.** Workers write results to `$ORCH_DIR/<label>.json` and signal via `busChannel`. Synthesize before passing downstream — never relay verbatim.

Workers can also publish structured results from inside their prompt; the exit shim is the crash-safe fallback.

---

## Debugging

When `bus wait` times out: `tmux read` to see what's on screen. Common causes: permission gate (`tmux send` to approve), silent crash, wrong `PI_BUS_SESSION`. Use `--no-extensions` to prevent permission gates.

Re-spawn failed workers with a new label suffix (e.g., `scout-a-retry`). Don't re-run the whole pipeline.

---

## Error Handling

- Adjust prompt/scoping/file args before retrying — identical retries produce identical failures
- Broken tests: spawn a focused fix worker with test output + relevant files
- Crashed worker: re-spawn with new label suffix; labels must be unique within a run

---

## Context Gathering

Before implementation, gather with a cheap read-only scout (no `orch` needed):

```bash
pi --no-session --tools read,bash --no-skills --model claude-haiku-4-5 \
  "Analyze this repo for: [TASK]. Report only:
   1. Stack and toolchain  2. Exact build/test/lint commands
   3. Files relevant to the task  4. Conventions that constrain implementation
   Structured output only. Write to /tmp/scout-context.json."
```

---

## Multi-Agent Dialogue

For design decisions requiring back-and-forth: spawn agents on a shared bus channel with the same material but different context emphasis. If two exchanges don't produce movement, bring both positions to the human.

Sonnet ↔ Sonnet for known solution space; Sonnet ↔ Opus for genuine uncertainty.
