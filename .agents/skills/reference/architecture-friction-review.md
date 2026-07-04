---
name: architecture-friction-review
description: Review code for architectural friction, module-depth opportunities, and better seams. Use when asked to improve architecture, find better boundaries, or pressure-test a refactor candidate.
---

# Architecture Friction Review

A review technique for finding places where deeper modules or better seams would improve understanding, changeability, and tests.

## Intent

Find places where the codebase would become easier to understand, change, and test by deepening modules or moving seams.

Look for:

- shallow modules with orchestration complexity spread across call sites
- leaky interfaces that expose implementation details
- seams that make tests reach through the interface
- extracted pure functions that miss the bugs that occur in orchestration
- dependencies crossing boundaries without an adapter or ownership model
- concepts that require bouncing across many files to understand

## Workflow

1. **Respect local process first**
   - Read repository instructions before code review work.
   - Use language-aware navigation tools when available.
   - Load the local notes/storage adapter before creating durable reports, summaries, templates, or decision records.
2. **Build domain vocabulary**
   - Reuse names from code, docs, tests, and notes.
   - Keep a working glossary inside the review artifact when helpful.
   - If the destination for durable vocabulary is unclear, ask where it should go.
3. **Explore for friction**
   - Trace core workflows, call boundaries, tests, and configuration seams.
   - Prefer evidence from code and tests over abstract style preferences.
   - Note both the current pain and the change that would reduce it.
4. **Classify dependency shape**
   - **In-process**: same runtime, direct calls are acceptable if locality is high.
   - **Local-substitutable**: implementation can be swapped locally for tests or migration.
   - **Remote but owned**: use ports/adapters to isolate protocol and deployment concerns.
   - **True external**: isolate behind a mockable adapter and keep external assumptions explicit.
5. **Present candidates**
   - Produce 3-5 candidates unless the user asks for a narrow review.
   - Use visual reports when they improve comprehension.
   - Store durable summaries and sidecars using local adapter conventions.
6. **Grill the selected candidate**
   - Switch to the `grill` technique for seam placement, interface shape, adapters, tests, migration, rollback, and deletion plan.
7. **Capture outcome**
   - Durable outputs should be decisions, task breakdowns, design notes, or implementation plans according to local convention.
   - If the destination is unclear, ask where the outcome should go.

## Candidate Card

Use this shape for each opportunity:

```md
## {Candidate title}

- **Files/modules**:
- **Problem**:
- **Proposed deepening**:
- **Dependency category**:
- **Why this improves locality**:
- **Why this improves leverage**:
- **Test impact**:
- **Recommendation**: Strong / Worth exploring / Speculative
- **Open questions**:
```

## Review Heuristics

Prefer changes that:

- reduce the number of files needed to understand one behavior
- make invalid states or invalid call sequences harder to express
- move policy closer to the data or workflow it governs
- put IO and external assumptions behind explicit boundaries
- let tests target behavior through stable seams
- create a migration path with deletable intermediate states

Be cautious of changes that:

- add interfaces without improving locality or test leverage
- split cohesive behavior across more files
- hide simple code behind patterns that reduce readability
- require a big-bang migration without rollback
- optimize for tests while leaving production orchestration unchanged

## Durable Output

The local adapter decides where durable information lives. A useful architecture review summary usually contains:

```md
# Architecture review — {scope}

## Scope
What was reviewed and why.

## Domain vocabulary
Only terms needed to understand the candidates.

## Candidates
3-5 candidate cards.

## Selected candidate
Decision, rationale, risks, and next steps.

## Follow-ups
Implementation slices, tests, and open questions.
```

Adapt this to existing templates, indexes, or report locations. If the destination is unclear, ask the user where it should go.
