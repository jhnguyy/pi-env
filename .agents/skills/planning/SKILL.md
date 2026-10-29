---
name: planning
description: Define a change's scope, success criteria, implementation sequence, and rollout evidence. Use when defining a change, planning delivery, or reviewing a design or architecture proposal.
---

# Planning

## Frame the change

Identify the affected users, the outcome they need, and the benefit it would provide. Trace the workflow, dependency, or assumption that blocks that outcome, including the conditions and consequences for those affected. State what the plan includes and excludes.

Test the premise behind the proposed approach. Ask what is observed, what is inferred, and which uncertainty could change the approach. Choose an observation that could disprove the premise. Consider how the system would look if the requirement had existed from the start, then account for migration from the current design.

Before decomposing work, define:

- what must become true and what must remain true
- observable evidence that would establish success or expose failure
- constraints, non-goals, and accepted risks
- unresolved assumptions that could change the plan

Use a design document to work through consequential decisions and gather feedback. Include implementation and delivery details when reviewers need them to assess the proposal.

## Derive implementation and verification

Compare viable approaches against the success criteria, consequences, and ease of repair. Choose the smallest approach that can fulfill the outcome. Derive implementation, verification, and rollout steps from it, including dependencies and checkpoints.

Choose evidence while the design can still change. Identify where the outcome can be observed and which claims require real operating conditions. Follow the [testing-practices skill](../testing-practices/SKILL.md) to select checks and assess their limits.

For each consequential unknown, record the affected decision, how to resolve it, and who will resolve it or when resolution is required. Include operating concerns when they change scope, sequence, verification, rollout, or responsibility.

Identify responsibility for implementation, verification, rollout, and follow-up, including the limits of delegated work. Use checkpoints to ask whether new evidence changes the approach, scope, or commitments; communicate revisions to those who depend on the plan.

## Plan rollout and outcome verification

For changes that require deployment:

1. Establish compatibility, migration, configuration, observability, rollout, and rollback needs.
2. Define how to confirm that the intended revision, configuration, migrations, and flags reached the target environment.
3. Define how to exercise changed behavior under real conditions and compare results with the success criteria.
4. Assign observation of delayed effects, regression response, and removal of temporary mechanisms.

Use deployment evidence to confirm arrival, then outcome evidence to assess success. For changes without deployment, choose the environment where the outcome can actually be verified. State the conditions and limits of that evidence.

## Close the plan

Close work only when evidence meets the success criteria. Give each material remaining item a disposition: completed, assigned, deferred with a trigger or date, blocked with an escalation path, or excluded with rationale.

Identify who needs an update, what they need to know, and who owns any further action or delayed-effect checks.
