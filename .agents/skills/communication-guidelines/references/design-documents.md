# Design Documents

Use this reference when drafting or reviewing a design document or architecture proposal. Its purpose is to help reviewers understand and assess consequential decisions before implementation makes them expensive to change.

The [planning skill](../../planning/SKILL.md) owns problem boundaries, success criteria, tradeoffs, and resolution paths. Use it to derive or assess the reasoning. This reference owns presentation. Follow local document conventions and authoritative specifications rather than creating competing sources.

## Select the depth

A design document is not necessary for every change. Use one when written review can resolve uncertainty, coordinate participants, or prevent an expensive misunderstanding. Keep low-risk, reversible work brief.

Select content by what reviewers must decide or challenge. The sections below are review prompts, not a mandatory template. Omit detail that cannot affect a decision or reveal a material misunderstanding.

## Establish the proposal

Open with the problem, intended outcome, and recommended approach. Make the opening understandable to the expected stakeholders without an oral briefing. Introduce specialist detail after readers understand why it matters.

State the scope boundary. Include non-goals when readers could reasonably expect them to be in scope. Make the requested decision or feedback explicit.

Use a concrete scenario when abstract requirements leave behavior ambiguous. Show what a user or system does, what happens next, and the observable result. Distinguish required behavior from illustrative implementation choices.

## Make the design inspectable

Explain the consequential commitments and why they satisfy the success criteria. Describe strong alternatives and the tradeoffs behind the recommendation. Link to authoritative contracts and evidence instead of copying complete specifications.

Select the following details only when they affect review:

- **Flow and boundaries:** Trace a representative interaction across components, dependencies, and trust boundaries. Use a diagram when it explains relationships more clearly than prose. Retain editable diagram source.
- **Interfaces:** State the behavior that other components or users must rely on, including relevant failure semantics and compatibility constraints.
- **Operations:** Explain how material failures become visible and how recovery works. Include measurable service expectations when they drive the design.
- **Security and privacy:** Explain relevant threats, authority, sensitive-data access, and retention. Do not substitute a claim that the design is secure for an account of the risk.
- **Delivery:** Explain migration, rollout, and rollback when those constraints can change the proposed design. Do not invent a release plan for a request limited to design.

Leave inexpensive, reversible implementation choices to implementation unless reviewers need them to assess feasibility.

## Expose decision state

Separate settled decisions, assumptions, and open questions. Apply the planning skill's resolution-path guidance to consequential unknowns. Give reviewers enough context to understand what remains blocked or provisional.

When a question is resolved, preserve the decision and non-obvious rationale in the appropriate durable source. Link to supporting discussion when useful. Do not copy the full discussion history into the document by default.

Distinguish measurements and completed experiments from estimates and proposed checks. Never present planned validation as evidence already obtained.

## Review before polishing

Read the opening and headings without the body. Can each intended reviewer find the proposal, its justification, and the decisions that need their input?

Then trace a representative scenario through the design. Check for missing transitions, conflicting requirements, unexplained assumptions, and interfaces whose behavior is ambiguous. Resolve those issues before sentence-level editing.
