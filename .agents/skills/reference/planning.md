---
name: planning
description: Transform a request into a scoped, testable delivery path that continues through production landing and explicit closure. Use when the user asks to apply ownership to feature, roadmap, migration, or operational planning.
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
- Treat ownership as complete accounting of responsibility; delegation and explicit boundaries are valid outcomes.

## Transformation

### 1. Derive the scoped problem

Treat the request as input to refine. Derive only the scopes that can affect the plan:

- **Local:** What behavior is broken, missing, or desired?
- **User:** Who is affected, and what outcome is blocked?
- **System:** What workflow, dependency, data flow, or assumption produces the condition?
- **Strategic:** Why does this matter to the product or roadmap?

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

1. **Prepare:** establish compatibility, migration, configuration, observability, rollout, and rollback needs.
2. **Release:** confirm the intended revision, configuration, migrations, and flags reached the environment successfully.
3. **Exercise:** invoke the changed behavior under real conditions and compare evidence with the success contract.
4. **Stabilize:** observe delayed effects, address regressions, remove temporary mechanisms, and capture follow-up work.

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

Adapt this shape to local planning conventions; omit sections that cannot affect action or judgment.

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
