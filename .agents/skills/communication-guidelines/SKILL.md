---
name: communication-guidelines
description: Write and review durable or outward-facing technical text, including documentation, procedures, design documents, comments, logs, commits, pull requests, and correspondence.
---

# Communication Guidelines

When drafting or reviewing a design document or architecture proposal, also read [design-documents.md](references/design-documents.md).

## Vocabulary and terminology

- Prefer common, familiar words. Use each word with one meaning and one part of speech in a given context.
- Ground terminology in the surrounding work.
- Use one term for each concept.
- Use technical nouns only to name defined items or concepts. Use technical verbs only to name defined actions or processes.
- Avoid contractions when they can reduce clarity.
- Use American English spelling unless another authority requires a different spelling.

## Verbs and voice

- Prefer the infinitive, imperative, simple present, simple past, or simple future form.
- Avoid progressive, perfect, and other complex verb constructions when a simple form has the same meaning.
- Use a verb to state an action. Avoid nominalizations that hide the action or the actor.
- Limit an `-ing` form to a defined technical term when practical. Rewrite the sentence when the form creates ambiguity.

## Sentences and lists

- Write complete, clear sentences. Do not remove necessary articles, subjects, verbs, or other words to make a sentence shorter.
- Put one topic in each descriptive sentence.
- Put a condition first when the reader must know the condition before the action.
- Use a vertical list when a sentence contains a complex sequence, a set of alternatives, or several conditions.
- Use stable connecting words to show addition, contrast, sequence, cause, or result.
- Use articles and demonstrative adjectives when they identify which item the text means.
- Do not use a semicolon. Divide the text into separate sentences.
- Use parentheses only for short references, identifiers, abbreviations, explanations, or alternatives. Move important information into the main sentence.

## Procedures

- Use no more than 20 words in an instruction when practical.
- Put one instruction in each sentence. Combine actions only when they occur at the same time or form one operation.
- Start an instruction with an imperative verb.
- Use a note for information only. Do not hide an instruction in a note.
- Show the order of steps with numbers or letters when order is important.
- State prerequisites and the tested environment when they affect reproducibility. Do not imply support for untested environments.
- Make commands copyable. Distinguish commands from output and identify values the reader must replace. Preserve necessary safety confirmations.
- Name each file and show where an edit belongs. Keep examples runnable at meaningful checkpoints.
- Give checks and expected results at checkpoints and completion so readers can distinguish success from failure. Link to a complete runnable example when useful.

## Descriptions

- Use no more than 25 words in a descriptive sentence when practical.
- Give information gradually. Start with the main subject and add details in a logical order.
- Keep one topic in each paragraph.
- Keep a paragraph to six sentences when practical.
- Repeat key terms and key phrases when repetition makes the relationship between ideas clear.

## Safety information

- Identify the level and type of risk with the term that the applicable safety policy requires.
- Start with a clear command or condition.
- State the hazard and its possible result. Do not rely on vague statements about importance.
- Distinguish harm to people from damage to equipment or data.

## Pronouns and ambiguous constructions

- Make each pronoun refer to one clear noun. Repeat the noun if more than one interpretation is possible.
- Use `this` with a noun when `this` alone can refer to more than one idea.
- Check each use of `with`. State whether it shows association, accompaniment, or the means of an action.
- Use `that` when it clearly separates a main clause from a dependent clause.
- Write English phrases instead of Latin abbreviations such as `e.g.`, `i.e.`, or `etc.`.
- Use neutral and inclusive terms.
- Use a possessive form only when ownership or association is clear.

## Comments and log messages

- Write a comment as concise descriptive text.
- Write a log message as a short statement of the event or change and its effects.
- Use the same terms in logs, code, documentation, and operator procedures.
