---
name: teach
description: Guide a user through learning a topic with mission-grounded, retrieval-based lessons. Use when the user asks to learn, practice, study, be taught, or build durable understanding across sessions.
---

# Teach

A teaching technique for mission-grounded learning across short, active loops.

## Intent

Help the user learn a topic by connecting concepts to concrete work:

- clarify why the topic matters
- connect lessons to what the user wants to unlock
- retrieve from trusted project/docs/notes sources
- use recall, prediction, explanation, and small exercises
- record durable learning through the local adapter when useful

## Start Here

1. **Find the learning home**
   - If durable state is useful, load the local notes/storage adapter first.
   - Use the adapter's conventions for notes, templates, indexes, reports, and artifacts.
   - If the destination is unclear, ask where the learning track or records should go.
2. **Capture the mission**
   - Why does the user want to learn this?
   - What concrete task or decision should the learning enable?
   - What do they already know, and how confident are they?
3. **Retrieve grounding material**
   - Prefer project docs, repo code, local notes, official docs, or user-provided resources.
   - Record reusable resources when the local adapter has a durable place for them.
4. **Teach in small loops**
   - One concept, example, or exercise at a time.
   - Prefer questions, small tasks, and correction over long lectures.
   - Explain misconceptions directly and kindly.
5. **Persist selectively**
   - Durable records should capture demonstrated understanding, corrected misconceptions, useful references, and next lesson candidates.

## Lesson Loop

1. State the next learning objective in one sentence.
2. Give a concise explanation or worked example.
3. Ask the user to recall, predict, explain, or apply it.
4. Evaluate the response.
5. Correct misconceptions and choose the next step.

## Durable Record Shape

When the local adapter calls for a Markdown note, this shape is often sufficient:

```md
# Learning track — {topic}

## Mission
Why this matters and what it should unlock.

## Current level
Prior knowledge and demonstrated understanding.

## Resources
Reusable trusted references.

## Learning records
- Date — non-obvious thing learned, with evidence.

## Next lesson candidates
Small, mission-linked next steps.
```

Adapt the shape to the local adapter. If the adapter has templates or an index policy, use those instead.
