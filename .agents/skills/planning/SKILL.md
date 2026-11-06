---
name: planning
description: Define a change's scope, success criteria, implementation sequence, and rollout evidence. Use when defining a change, planning delivery, or reviewing a design or architecture proposal.
---

# Planning

## Frame the change

Identify the affected users, blocked outcome, and the workflow, dependency, or assumption that produces the problem. State what the plan includes and excludes.

Test the premise behind the proposed approach. For uncertainty that could change the approach, choose an observation that could disprove the premise. Consider how the system would look if the requirement had existed from the start, then account for migration from the current design.

Before decomposing work, define:

- what must become true and what must remain true
- observable evidence that would establish success or expose failure
- constraints, non-goals, and accepted risks
- unresolved assumptions that could change the plan

Use a design document only when written review would resolve consequential uncertainty or coordinate participants.

## Derive implementation and verification

Evaluate approaches against the success criteria. Derive implementation, verification, and rollout steps from the selected approach, including dependencies and checkpoints.

Choose evidence while the design can still change. Identify where the outcome can be observed and which claims require real operating conditions. Follow the [testing-practices skill](../testing-practices/SKILL.md) to select checks and assess their limits.

Identify consequential unknowns and how to resolve them. Assign responsibilities when work actually requires coordination.

## Plan rollout and outcome verification

For changes that require deployment:

1. Establish compatibility, migration, configuration, observability, rollout, and rollback needs.
2. Define how to confirm that the intended revision, configuration, migrations, and flags reached the target environment.
3. Define how to exercise changed behavior under real conditions and compare results with the success criteria.
4. Assign observation of delayed effects, regression response, and removal of temporary mechanisms.

Deployment evidence proves arrival, not success. For changes without deployment, choose the environment where the outcome can actually be verified.

## Close the plan

Compare the evidence with the success criteria and report material remaining gaps.
