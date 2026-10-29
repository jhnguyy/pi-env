---
name: communication-guidelines
description: Write and review durable or outward-facing technical text, including documentation, procedures, design documents, comments, logs, commits, pull requests, and correspondence.
---

# Communication Guidelines

When drafting or reviewing a design document or architecture proposal, also read [design-documents.md](references/design-documents.md).

## Establish the reader's task

Identify what the reader needs to understand, decide, or do, and what benefit the text should make possible. Lead with that purpose. Select detail with care for the reader's knowledge, working conditions, and consequences of misunderstanding.

Use the terms readers encounter in the relevant code, interfaces, and documentation. Explain unfamiliar terms where they first matter, and distinguish concepts whose similar names could cause confusion. Follow the destination's spelling and terminology conventions.

## Procedures

State prerequisites and the tested environment when they affect reproducibility. Distinguish tested support from assumptions about other environments.

Number steps when order matters. Place prerequisites and conditions before the actions they govern, and keep required actions in the procedure rather than hiding them in notes.

Make commands copyable, distinguish them from output, and identify values readers must replace. Name each file and show where an edit belongs. Preserve necessary safety confirmations.

Keep examples runnable at meaningful checkpoints. Give checks and expected results so readers can distinguish success from failure, and link to a complete runnable example when useful.

## Safety information

Place safety information before the action that exposes readers to the hazard. State the relevant condition or protective action, the hazard, and its possible consequence. Use the risk terminology required by the applicable safety policy, distinguishing harm to people from damage to equipment or data.

## Operational messages

Write log messages that identify the event or change and its effects. Use the same terms in logs, code, documentation, and operator procedures so readers can connect the message to the affected behavior.

## Check understanding and complete the explanation

Trace a representative example or procedure through the draft. Can the intended reader reach the result, recognize success, and find who is responsible if it fails? Use that inquiry to find missing transitions, ambiguous references, and conditions separated from the actions they govern. Repeat a noun when a pronoun could refer to different things. Split or combine sentences and use connecting words to make sequence, cause, contrast, and conditions explicit.

Match claims to evidence and state its limits: distinguish observations from inferences, tested results from proposed checks, and commitments from possibilities. Keep the detail proportionate to the decision or action the reader faces.

When receiving a correction, examine the passage and its supporting evidence. Ask which fact, interpretation, or reader need differs when that is unclear; revise the explanation as the reasons warrant. Check dependent examples and instructions after a correction so the repair is complete.
