# Testing

Tests should explain why a change is trustworthy at a cost the project can sustain. This repository includes pure decision logic, model-facing tools, persisted workflows, and long-lived processes. Those boundaries need different kinds of evidence; one test style cannot serve them all well.

A workflow test can establish that components work together. A focused test can expose a large space of policy decisions or make a rare failure reproducible. Prefer the boundary that reveals the relevant defect without reconstructing unrelated parts of the application. Additional coverage is useful when it answers a different question, not merely because it sits in another layer.

## What confidence means here

For model-facing tools, useful output matters as well as valid metadata. For persisted workflows, recovery and conflicting updates matter as well as the initial successful operation. For process-owning features, cancellation is not complete until the promised external work has settled. Choose observations that distinguish those outcomes from intermediate progress.

Lifecycle fixtures deserve the same care as the feature. A failed startup or assertion must not strand a server, writer, listener, or temporary workspace. Share expensive setup when scenarios can remain independent; keep mutable state separate when sharing would obscure ownership or make results order-dependent.

Test cost includes startup, subprocesses, memory, and failure diagnosis—not just assertion count. Reducing repeated application setup can be more valuable than removing small tests. Before consolidating coverage, identify which failure each scenario detects and whether the replacement still exposes it.

## Working guidance

The [testing-practices skill](../../.agents/skills/testing-practices/SKILL.md) covers scenario design, test doubles, and evidence. [Effect guidance](effect-guardrails.md#tests) covers its runtime and test services. [CONTRIBUTING](../../CONTRIBUTING.md#verification) explains how to select and run repository checks.

Keep temporary diagnostic experiments separate from retained regression coverage. Preserve evidence that helps explain a failure, using CI output where it is sufficient and additional artifacts where the result would otherwise be difficult to inspect.
