---
name: grill
disable-model-invocation: true
description: Stress-tests plans, designs, and decisions through one-question-at-a-time interrogation. Use when the user asks to be grilled or challenged before acting.
---

# Grill

## Interrogate the plan

1. Summarize the proposal, intended outcome, constraints, and biggest visible risk.
2. Map the decision branches: goals, non-goals, dependencies, failure modes, rollback, success criteria, and unresolved choices.
3. Select the next consequential unresolved branch. Use available evidence to narrow it before asking the user.
4. Ask one question. Explain the decision or risk it tests, why it matters, your recommended answer or current hypothesis, and what a different answer would change.
5. Wait for the user's answer. Turn it into a decision or explicit assumption, update the remaining branches, and repeat.

## Capture decisions

Summarize settled decisions, their rationale, remaining assumptions, risks, and open questions rather than reproducing the interrogation.

Before writing a durable artifact, follow repository and local adapter rules for templates and destinations. If no destination is established, ask the user where the decisions should go.
