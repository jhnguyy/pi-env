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

- Derive decisions before tasks. Define the problem and success contract before adding implementation detail.
- Evaluate the premise before implementation. Identify the assumption that makes the proposed approach necessary and check it against available evidence. When uncertainty can change the approach, choose an observation that could contradict the assumption.
- Consider how the system would look if the requirement had been present from the start. Use that design to compare approaches.
- Scale depth with consequence, uncertainty, and irreversibility. Keep low-risk, reversible work terse.
- Treat ownership as a complete account of responsibility. Delegation and explicit boundaries are valid outcomes.

## Design documents

Use the design document to work through consequential decisions and gather feedback. Explain the problem, intended outcome, proposed approach, and unresolved questions. Include implementation and delivery details when reviewers need them to assess the proposal.

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

Include operating concerns only when they can change scope, approach, sequence, verification, rollout, or ownership.

For each consequential unknown, record the question, affected decision, resolution method, and resolution point or owner.

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
