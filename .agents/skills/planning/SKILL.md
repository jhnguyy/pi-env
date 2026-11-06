---
name: planning
description: Define a change's scope, success criteria, implementation sequence, and rollout evidence. Use when defining a change, planning delivery, or reviewing a design or architecture proposal.
---

# Planning

## What outcome?

Identify the problem and requested outcome. Establish the scope and the existing behavior to preserve. Define observable success criteria and distinguish requirements from assumptions.

Test consequential assumptions with observations that could disprove them before committing to an approach.

## What approach?

Compare approaches against the outcome. Consider how the system would look if the requirement had existed from the start, accounting for the transition from the current design.

Sequence work around useful outcomes and resolve consequential unknowns before dependent work proceeds. Assign responsibilities when coordination requires them. Use a design document only when written review would resolve uncertainty or coordinate participants.

For deployment, include the compatibility and recovery measures the change needs. Plan how to confirm that the intended change reached the target environment and who will observe delayed effects.

## What evidence?

Choose evidence while the approach can still change, using the [testing-practices skill](../testing-practices/SKILL.md). Identify where the outcome can be observed and which claims require real operating conditions.

Deployment evidence proves arrival, not success. Verify the changed behavior in the relevant environment, compare the evidence with the success criteria, and report material remaining gaps.
