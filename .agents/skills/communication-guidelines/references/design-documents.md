# Design Documents

Use this reference when drafting or reviewing a design document or architecture proposal. Its purpose is to help reviewers understand and assess consequential decisions before implementation makes them expensive to change.

The [planning skill](../../planning/SKILL.md) owns problem boundaries, success criteria, tradeoffs, and resolution paths. Use it to derive or assess the reasoning. This reference owns presentation. Follow local document conventions and authoritative specifications rather than creating competing sources.

## Select the depth

A design document is not necessary for every change. Use one when written review can resolve uncertainty, coordinate participants, or prevent an expensive misunderstanding. Keep low-risk, reversible work brief.

Select content by what reviewers must decide or challenge. The sections below are review prompts, not a mandatory template. Omit detail that cannot affect a decision or reveal a material misunderstanding.

## Establish the proposal

Use a recognizable title. Make the document's owner, authoritative location, and review or approval state clear through the host system or document metadata. Do not imply agreement that reviewers have not given.

Open with the problem, intended outcome, and recommended approach. Make the opening understandable to the expected stakeholders without an oral briefing. Explain the motivation and relevant prior attempts. State goals as benefits or observable outcomes, not merely technology choices.

Order later detail for the readers who need it. Explain unfamiliar terms where they first matter rather than relying on a glossary. Link to related designs, specifications, and test plans when they supply necessary context.

State the scope boundary. Include non-goals when readers could reasonably expect them to be in scope. Make the requested decision or feedback explicit.

Use a concrete scenario when abstract requirements leave behavior ambiguous. Show what a user or system does, what happens next, and the observable result. Distinguish required behavior from illustrative implementation choices.

## Make the design inspectable

Explain the consequential commitments and why they satisfy the success criteria. Describe strong alternatives and the tradeoffs behind the recommendation. Link to authoritative contracts and evidence instead of copying complete specifications.

Select the following details only when they affect review:

- **Flow and boundaries:** Trace a representative interaction across components, dependencies, and trust boundaries. Use a diagram when it explains relationships more clearly than prose. Retain editable diagram source.
- **Interfaces:** Show the interactions people and systems rely on, such as UI sketches, API or CLI semantics, and file formats. Include relevant failure semantics and compatibility constraints.
- **Constraints and dependencies:** Explain limits imposed by budget, clients, infrastructure, or existing systems. Identify consequential language, runtime, storage, and service choices and their maintenance costs.
- **Operations:** State measurable expectations for availability, latency, or capacity when relevant. Explain how they will be measured, which failures need alerts, and how recovery works. Identify diagnostic events, log access and retention, and sensitive data that must not enter logs.
- **Security and privacy:** Explain threats, attack surface, trust boundaries, and controls. Identify sensitive data, who can access it, how it is protected, and how long it is retained. If a plausible risk is dismissed, explain why so reviewers can challenge the assumption.
- **Legal obligations:** Identify applicable contractual, licensing, or regulatory constraints and unresolved review needs. Distinguish confirmed obligations from questions requiring qualified review.
- **Delivery:** Explain migration, rollout, and rollback when those constraints can change the proposed design. When milestones matter, tie them to useful artifacts or feedback that can expose mistaken assumptions early. Do not invent dates or a release plan for a request limited to design.

Leave inexpensive, reversible implementation choices to implementation unless reviewers need them to assess feasibility.

## Expose decision state

Separate settled decisions, assumptions, and open questions. Apply the planning skill's resolution-path guidance to consequential unknowns. Give reviewers enough context to understand what remains blocked or provisional.

When a question is resolved, preserve the decision and non-obvious rationale in the appropriate durable source. Link to supporting discussion when useful. Do not copy the full discussion history into the document by default.

Distinguish measurements and completed experiments from estimates and proposed checks. Never present planned validation as evidence already obtained.

## Review before polishing

Read the opening and headings without the body. Can each intended reviewer find the proposal, its justification, and the decisions that need their input?

Then trace a representative scenario through the design. Check for missing transitions, conflicting requirements, unexplained assumptions, and interfaces whose behavior is ambiguous. Resolve those issues before sentence-level editing.
