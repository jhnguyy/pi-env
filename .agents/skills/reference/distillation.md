---
name: distillation
description: Compress verbose design docs, worklogs, and notes into dense, current-state references. Use when docs contain completed phases, stale plans, or session-specific reasoning that has crystallized into lessons.
---

# Distillation

**Documents only — not sessions.** For session context management, use the handoff skill.

---

## What to Keep vs Drop

| Keep | Drop |
|------|------|
| Spec decisions and the reasoning that makes them non-obvious | Planning rationale for decisions already made |
| Current-state facts | Historical state (what was true during build) |
| Lessons that generalize beyond the project | Session-specific bug narratives once fixed |
| Open items not yet resolved | Completed open items, done TODOs |
| Failure modes and their fixes | Narrative of how the fix was found |
| Conventions and constraints that still apply | Agent topology / execution plans for done work |

---

## Process

1. **Read the source** — retrieve and read the actual doc; never distill from memory
2. **Identify the audience** — agent-facing (skill/doc) vs human-facing (note/worklog)
3. **Audit each section** — label it: planning, historical, current-state, or lessons
4. **Distill** — keep durable content, drop transient content, correct stale claims
5. **Verify facts** — cross-check claims against current file/code state before writing
6. **Write once** — produce the final artifact; don't preserve a "before" alongside the "after"

---

## Primary Artifact: Index, Not Summary

The best distillation output is an **index** — a dense navigational map — not a prose summary. Test: can someone locate a specific fact without reading the original? If they'd need the original anyway, the summary lost too much.

Extract key facts and patterns, not narrative. Detailed examples and full specs belong in reference files the index points to.

---

## Output Formats

**Reference doc** (replaces a planning doc):
- Lead with current-state facts, not project history
- Tables, code blocks, bullets — minimal prose
- No "Phase N" structure unless phases are ongoing
- Add "Implementation Notes" for post-build learnings

**Lessons doc** (extracted from a worklog):
- Named learnings, not session numbers
- Each lesson: what + why + where it applies
- Drop timestamps, sequential narrative, debugging play-by-play

**Skill update** (promotes an open item to first-class):
- Add the pattern as primary content, not an appendix
- Remove "TODO", "Open Item", "Proposed" qualifiers
- Update examples to reflect current patterns

---

## Common Patterns

**Planning doc → Reference doc:** Strip phase numbers, rationale for settled decisions, agent topology for already-built work. Keep the spec (types, interfaces, layouts, conventions), implementation notes, known gotchas.

**Worklog → Lessons:** Strip session numbers, sequential narrative, transient bugs. Keep architectural decisions and why they stuck, failure modes and fixes, patterns that changed the design.

**Stale claim correction:** Read the actual source (file, extension, binary), compare to the claim, update inline. Do not propagate the stale version anywhere.

**Open item → First-class content:** Move it to the most relevant section as a primary rule/example. Delete the "Open Items" entry.
