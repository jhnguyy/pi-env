---
name: distillation
description: Compress verbose design docs, worklogs, and notes into dense, current-state references. Use when docs contain completed phases, stale plans, or session-specific reasoning that has crystallized into lessons.
---

# Distillation

**Documents only — not sessions.** For session context, use the handoff skill.

## What to Keep vs Drop

| Keep | Drop |
|------|------|
| Spec decisions and non-obvious reasoning | Planning rationale for settled decisions |
| Current-state facts | Historical state (what was true during build) |
| Lessons that generalize | Session-specific bug narratives once fixed |
| Open items not yet resolved | Completed items, done TODOs |
| Failure modes and their fixes | Narrative of how fixes were found |
| Active conventions and constraints | Agent topology / execution plans for done work |

## Process

1. **Read the source** — retrieve and read the actual doc; never distill from memory
2. **Identify audience** — agent-facing (skill/doc) vs human-facing (note/worklog)
3. **Audit each section** — label: planning, historical, current-state, or lessons
4. **Distill** — keep durable content, drop transient, correct stale claims against current code/file state
5. **Write once** — produce the final artifact; don't preserve a "before" alongside "after"

## Primary Artifact: Index, Not Summary

The best output is an **index** — a dense navigational map. Test: can someone locate a specific fact without reading the original? Extract key facts and patterns; detailed specs belong in reference files the index points to.

## Output Formats

**Reference doc** (replaces a planning doc):
- Lead with current-state facts, not history
- Tables, code blocks, bullets — minimal prose
- No "Phase N" unless phases are ongoing

**Lessons doc** (extracted from a worklog):
- Named learnings, not session numbers
- Each lesson: what + why + where it applies

**Skill update** (promotes an open item):
- Add pattern as primary content, not appendix
- Remove "TODO"/"Proposed" qualifiers; update examples

## Common Patterns

- **Planning doc → Reference:** Strip phase numbers, settled rationale, done agent topology. Keep spec, implementation notes, gotchas.
- **Worklog → Lessons:** Strip sequential narrative, transient bugs. Keep architectural decisions, failure modes, design-changing patterns.
- **Stale claims:** Read actual source, compare, update inline.
- **Open item → First-class:** Move to most relevant section as primary rule. Delete the open item entry.
