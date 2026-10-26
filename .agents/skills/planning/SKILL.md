---
name: planning
description: Turn an intended change into clear decisions and a verifiable path to the outcome. Use when defining a change, reviewing a design or architecture proposal, or planning delivery.
---

# Planning

Use this as a planning transformation, not as a generic checklist:

```text
request → scoped problem → success contract → delivery path → landed outcome → closure
```

## Operating Rules

- Derive decisions before tasks. Resolve the problem and success boundaries before adding implementation detail.
- Include a concern only when it can change scope, approach, sequence, verification, rollout, or ownership.
- Represent uncertainty as an open question, the decision it affects, and a concrete way to resolve it.
- Scale depth with consequence, uncertainty, and irreversibility. Keep low-risk, reversible work terse.
- Treat ownership as a complete account of responsibility. Delegation and explicit boundaries are valid outcomes.

## Scope and document writing

Apply the transformation to the requested work, not every possible phase. For design documents and proposals, derive the problem, success contract, decisions, and consequential unknowns before drafting. Include delivery, production landing, and closure only when they affect the proposal or belong to the requested plan.

A planning or design request does not authorize implementation, release, or remote writes. Distinguish proposed verification from evidence already obtained.

This skill owns decision reasoning. The [design-document writing reference](../communication-guidelines/references/design-documents.md) owns how to present that reasoning for review. Load it when drafting or reviewing a design document or architecture proposal.

## Transformation

### 1. Derive the scoped problem

Treat the request as input to refine. Derive only the scopes that can affect the plan:

- What local behavior is broken, missing, or desired?
- Who is affected, and what outcome is blocked?
- What system workflow, dependency, data flow, or assumption produces the condition?
- Why does this matter to the product or roadmap?

State the selected problem boundary and why broader or narrower scopes are excluded.

### 2. Establish the success contract

Before decomposing work, state:

- what must become true
- what must remain true
- what observable evidence establishes success
- constraints and non-goals
- accepted risks and unresolved assumptions

Use this contract to judge approaches and completion.

### 3. Derive the delivery path

Evaluate the proposed approach against the success contract. Surface alternatives only when they expose a material tradeoff. Derive implementation, verification, and rollout work from the selected approach.

Select operating concerns by relevance rather than enumeration. Examples include failure and recovery, data migration, compatibility, security, dependencies, observability, and maintenance.

For each consequential unknown, record:

```text
question → affected decision → resolution method → resolution point or owner
```

### 4. Plan production landing

Model landing as more than deployment:

1. Establish compatibility, migration, configuration, observability, rollout, and rollback needs.
2. Confirm the intended revision, configuration, migrations, and flags reached the environment successfully.
3. Invoke the changed behavior under real conditions and compare evidence with the success contract.
4. Observe delayed effects, address regressions, remove temporary mechanisms, and capture follow-up work.

“Deployed” means the change moved. “Landed” means the intended outcome works in its real environment.

### 5. Close residual responsibility

For every material remaining item, choose an explicit state:

- completed
- assigned
- deferred with a trigger or date
- blocked with an escalation path
- excluded with rationale

Identify necessary communication and later observation by affected party and purpose, not by generating a generic audience list. The work is closed when completion evidence satisfies the success contract and no material responsibility remains implicit.

## Output Shape

Adapt this shape to local planning conventions and the requested scope. It is not a required document template. Omit sections that cannot affect action or judgment.

```md
## Problem boundary
## Success contract
## Decisions and material tradeoffs
## Delivery path
## Production landing
## Open questions and resolution paths
## Residual responsibilities
## Completion evidence
```
