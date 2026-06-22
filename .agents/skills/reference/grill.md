---
name: grill
description: Stress-test a plan, design, decision, or architecture proposal one question at a time. Use when the user asks to be grilled, challenged, interrogated, or wants a plan reviewed before acting.
---

# Grill

A design interrogation technique for turning unclear plans into explicit decisions.

## Intent

Clarify and pressure-test a plan by walking the decision tree one branch at a time. The goal is better decisions, not a long list of questions.

Good targets:

- implementation plans
- architecture proposals
- incident responses
- migrations and rollouts
- personal or operational decisions with tradeoffs

## Core Workflow

1. **Restate the plan**
   - Summarize the user's proposal in one paragraph.
   - Name the intended outcome, constraints, and biggest visible risk.
2. **Map the decision tree**
   - Goals and non-goals
   - Constraints and dependencies
   - Risks and failure modes
   - Reversibility and rollback
   - Success criteria
   - Open decisions
3. **Answer what can be discovered**
   - If code, docs, notes, or configs can answer a question, inspect them instead of asking the user.
   - Follow repository and adapter rules before reading or writing artifacts.
4. **Ask one question at a time**
   - Include your recommended answer or current hypothesis.
   - Wait for the user's answer before moving to the next branch.
5. **Turn answers into decisions**
   - Summarize crystallized decisions, assumptions, and open questions.
   - If the destination for durable information is not given, ask where the summary or decisions should go.

## Prompt Pattern

Use this framing when starting a grill:

```text
I will grill this plan one branch at a time. For each question, I will give my recommended answer or current hypothesis, then wait. If code/docs/notes can answer it, I will inspect them instead of asking you.
```

## Question Pattern

Each question should include:

- the decision or risk being tested
- why it matters
- the recommended answer or hypothesis
- what would change if the answer is different

Example:

```md
Question 2 — Rollback boundary

If this migration fails halfway through, what is the smallest unit we can roll back independently?

My recommendation: make the adapter boundary the rollback unit, because it lets us keep the new call sites while swapping the implementation back. If that is wrong, the migration plan needs a stronger feature flag or a smaller first slice.
```

## Durable Output

When the grill produces durable value, prefer a concise decision summary:

```md
## Decision summary — {topic}

- **Decision**:
- **Why**:
- **Rejected options**:
- **Assumptions**:
- **Risks**:
- **Follow-ups**:
```

Use the templates, report locations, or note locations provided by the local adapter. If the location is unclear, ask the user where it should go.
