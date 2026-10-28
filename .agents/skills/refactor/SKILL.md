---
name: refactor
disable-model-invocation: true
description: Assess evidence-backed refactor opportunities, module seams, and test and migration impact. Use when asked to find structural improvements or evaluate a refactor candidate.
---

# Refactor

Assess opportunities without changing code. Implement only when the user authorizes implementation, then use the [code-contribution skill](../code-contribution/SKILL.md).

## Trace the friction

Read repository instructions and establish the review scope. Use language-aware navigation when available. Trace representative workflows through callers, module boundaries, tests, and configuration. Reuse domain terms from code and documentation.

Look for concrete costs:

- orchestration repeated across callers of shallow modules
- interfaces that expose internal state or sequencing
- behavior that requires visiting many files to understand or change
- tests that reach through interfaces or cover pure helpers while missing orchestration failures
- dependencies whose protocol, lifecycle, or failure assumptions leak across boundaries

Connect each candidate to code or test evidence and a current cost. Do not invent future requirements or generalize from similar names alone. No worthwhile refactor is a valid result.

## Evaluate the seam

Identify which responsibility should move and what the proposed interface would hide. Check whether deeper modules would reduce caller coordination without combining unrelated responsibilities.

Classify relevant dependencies to choose the boundary:

- Keep direct calls for in-process dependencies when they preserve locality.
- For locally substitutable dependencies, assess the replacement seam for tests or migration.
- Isolate protocol and deployment concerns for remote, owned dependencies through ports or adapters.
- Put external dependencies behind mockable adapters with explicit external assumptions.

Compare the candidate with leaving the code alone. Check whether it reduces the files and concepts needed to understand one behavior, keeps policy near its workflow or data, and prevents invalid call sequences.

Reject interfaces that merely add layers, fragment cohesive behavior, or simplify tests without improving production orchestration.

## Check tests and migration

Identify behavior and contracts that must remain unchanged, affected callers, and tests that would establish preservation through stable seams. Use the [testing-practices skill](../testing-practices/SKILL.md) for test selection.

Describe migration slices, compatibility needs, rollback, and deletion of temporary paths. Flag big-bang migrations and uncertain behavior preservation as costs, not implementation details to defer silently.

If the user requests an interactive challenge, use the [grill skill](../grill/SKILL.md) to pressure-test interfaces, adapters, tests, migration, rollback, and deletion.

## Report the assessment

Report only supported opportunities, with no candidate quota or required report template. For each, give the affected files or modules, observed cost, proposed seam, expected benefit, test and migration impact, and recommendation. State unresolved questions and the next evidence needed for uncertain candidates.

Keep the assessment in the response unless a durable artifact is requested or required by local policy. Before creating one, load the local notes or storage adapter and follow its conventions. Ask if the destination is unclear. Capture the selected decision and follow-up work rather than duplicating the entire exploration.
