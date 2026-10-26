---
name: planning
description: Turn an intended change into clear decisions and a verifiable path to the outcome. Use when defining a change, reviewing a design or architecture proposal, or planning delivery.
---

# Planning

Use this workflow to turn a request into a plan and verify the outcome:

```text
request → problem and scope → success criteria → implementation and rollout plan → verified outcome → remaining work
```

## Operating Rules

- Make decisions before defining tasks. Define the problem and success criteria before adding implementation detail.
- Evaluate the premise before implementation. Identify the assumption that makes the proposed approach necessary and check it against available evidence. When uncertainty can change the approach, choose an observation that could contradict the assumption.
- Consider how the system would look if the requirement had been present from the start. Use that design to compare approaches.
- Match planning detail to the change’s risk, uncertainty, and reversibility. Keep low-risk, reversible work brief.
- Identify who is responsible for implementation, verification, rollout, and follow-up. Record delegated work and the limits of each responsibility.

## Design documents

Use the design document to work through consequential decisions and gather feedback. Explain the problem, intended outcome, proposed approach, and unresolved questions. Include implementation and delivery details when reviewers need them to assess the proposal.

## Workflow

### 1. Define the problem and scope

Use the request to identify the problem and the work needed to solve it:

- What local behavior is broken, missing, or desired?
- Who is affected, and what outcome is blocked?
- What system workflow, dependency, data flow, or assumption produces the condition?
- Why does this matter to the product or roadmap?

State what the plan includes and excludes, and explain why.

### 2. Define the success criteria

Before decomposing work, state:

- what must become true
- what must remain true
- what observable evidence establishes success
- constraints and non-goals
- accepted risks and unresolved assumptions

Use these criteria to evaluate approaches and determine when the work is complete.

### 3. Plan implementation, verification, and rollout

Evaluate the proposed approach against the success criteria. Compare alternatives when their tradeoffs can change the decision. Derive implementation, verification, and rollout work from the selected approach.

Include operating concerns only when they can change scope, approach, sequence, verification, rollout, or ownership.

For each unknown that can change the plan, record the question, affected decision, and how to resolve it. State who will resolve it or when it must be resolved.

### 4. Verify the outcome in production

Plan how to deploy the change and verify that it works:

1. Establish compatibility, migration, configuration, observability, rollout, and rollback needs.
2. Confirm the intended revision, configuration, migrations, and flags reached the environment successfully.
3. Exercise the changed behavior under real conditions and compare the results with the success criteria.
4. Observe delayed effects, address regressions, remove temporary mechanisms, and capture follow-up work.

Deployment confirms that the change reached the environment. Verification establishes whether the changed behavior meets the success criteria.

### 5. Resolve remaining work

For every material remaining item, choose an explicit state:

- completed
- assigned
- deferred with a trigger or date
- blocked with an escalation path
- excluded with rationale

State who needs an update, what they need to know, and who will check for delayed effects. Close the work when the evidence meets the success criteria and each remaining item has an explicit status. Assign responsibility for any further action.
