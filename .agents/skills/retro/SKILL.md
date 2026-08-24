---
name: retro
description: Reviews a selected pi coding session and proposes evidence-based improvements to tools, checks, documentation, skills, information access, and review policy. Use only when the user explicitly requests a session retrospective.
disable-model-invocation: true
---

# Session Retrospective

Review how the agent environment affected the session. Do not review only the resulting code.

## Select Evidence

1. Use `list_sessions` to find the session that the user identifies.
2. If the user does not identify a session, select the current session.
3. Use `read_session` for the bounded session view.
4. Read the repository instructions and the source authorities that governed the work.
5. State any evidence that the bounded view does not expose. Do not infer hidden assistant actions or successful tool output.

## Review Categories

Report a candidate only when session evidence shows a material effect.

- **Navigation**: The agent could not find the owning file, contract, or dependency efficiently.
- **Automated checks**: A test, type check, lint rule, or policy check could have detected an error earlier.
- **Tool economy**: The agent repeated calls, requested excessive output, used the wrong tool, or serialized independent work.
- **Instruction quality**: An instruction was ambiguous, duplicated an authority, had no observable effect, or consumed unnecessary context.
- **Information access**: The agent lacked necessary logs, metadata, documentation, or read-only service access.
- **Review coverage**: Review or independent test design did not detect a material risk.

## Route Improvements

Prefer the strongest owner that can enforce the improvement:

1. Automated check or public contract
2. Tool or API design
3. Review or independent test policy
4. Source-owned documentation or skill
5. Passive steering instruction

Keep `AGENTS.md` as a navigation map. Put durable detail in the source that owns the behavior. Do not assume that a repository has a separate coding-standards file.

A single session usually supports a candidate, not a new rule. Recommend a durable instruction change only when one of these conditions applies:

- At least two related retrospectives show the pattern.
- The session exposes a high-severity safety or correctness failure.
- The current instruction conflicts with its source authority.

## Output

Present candidates in severity order. Use this form:

```md
## <candidate>

- **Severity**: high | medium | low
- **Category**:
- **Evidence**:
- **Impact**:
- **Proposed change**:
- **Owning source**:
- **Validation**:
- **Confidence**: high | medium | low
```

Separate observed facts from recommendations. Include a "No change" result when the evidence does not justify an environment change.

Keep the review read-only. Do not edit files, create tasks, or store a durable report unless the user approves that follow-up work. If the user approves a change, follow the repository workflow and validate the owning boundary.
