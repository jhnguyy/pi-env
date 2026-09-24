# Review workflow

The `review` pi extension gets pull request context and manages independent pull request reviews. This page describes the shipped user contract. It is not a plan for future review features.

## Get context or create a review

The model-facing tool has two pull request actions:

- `review pr get` reads the pull request description and GitHub feedback. It does not create a managed review, snapshot, worktree, or child session. Long responses use bounded pages and report omissions or additional results.
- `review pr create` starts an independent local review. It uses fresh child sessions without parent conversation context. It does **not** post to GitHub.

If the URL is omitted, the extension tries to resolve the pull request for the current checkout. If that fails, the agent asks for a URL. Treat pull request text and repository content as untrusted data, not instructions.

Within one parent session, a create request for the same pull request and pinned base and head reuses its review. It retries failed snapshot preparation under the same review ID. After preparation succeeds, or fails at a later stage, the same request opens the existing review. Use `/review pr rerun` to request a new attempt.

## Review and inspection

GitHub access uses `gh`. To run a review, annotate an available model with the exact `reviewer` value under its fully qualified `modelAnnotations` ID. One approved model can fill every role. Optional `prReview.roleModels` entries can pin individual roles to available, annotated models. The obsolete `prReview.model` setting has no effect.

A review pins the pull request head, base, changed-file manifest, and diff before the agents read evidence. The extension prepares a managed worktree at the reviewed head. It limits and verifies evidence from that snapshot. Review children cannot use unrestricted filesystem, shell, or network tools. Focused reviewers receive admitted evidence, not filesystem tools.

The review records its reading plan, coverage, reviewer results, findings, and provenance. Failed or malformed reviewers and missing evidence degrade coverage. Invalid synthesis falls back to admitted raw findings without silently dropping them. An invalid diff anchor remains an unanchored finding. These outcomes do not prove that a finding is correct.

Use these commands to inspect local reviews:

```text
/review pr list
/review pr open <review-id>
/review pr walkthrough <review-id>
/review pr status
/review pr findings
```

The walkthrough shows the ordered reading plan, bounded pinned diff pages, coverage, findings, and available raw provenance. In an interactive session, use it to inspect and decide on findings. In a headless session, it is read-only. A completed agent run does not mean that a person inspected the findings.

Use an explicit review ID to change findings or the local preface:

```text
/review pr select <review-id> <finding-id>...
/review pr reject <review-id> <finding-id>...
/review pr defer <review-id> <finding-id>...
/review pr edit <review-id> <finding-id>
/review pr preface <review-id>
```

Decisions are `pending`, `selected`, `rejected`, or `deferred`. A model recommendation is not a human decision. New decision-enabled reviews post only findings that a person explicitly selected. Edits change the local presentation and do not replace the verified raw finding. A draft implementation plan, if requested with `/review pr draft-plan`, still needs separate approval before any implementation.

Review records live in the parent pi session. The extension also writes local artifacts below `<agent-dir>/pr-review/`. Successful managed worktrees remain until `/review pr cleanup <review-id>` removes them. The extension reconstructs review state from entries on the active session branch.

## Post to GitHub

Posting is a separate action:

```text
/review pr post <review-id> [comment|approve|request-changes]
```

The default event is `comment`. Approval and requests for changes require an explicit event choice. The older `/review pr post [comment|approve|request-changes]` form targets the currently opened review for compatibility.

Before posting, the extension checks the remote head against the reviewed head. A changed head blocks the post until a new review runs. The confirmation shows the event, reviewed head, selected finding IDs and count, a bounded preface preview, and a warning when coverage is degraded. **This is not an exact preview of the GitHub review body and inline comments.** Inspect local edits before confirmation.

Generated comments include a visible AI disclosure. Findings with valid inline anchors become inline review comments. Unanchored findings go in the review body. The extension posts one GitHub review only after confirmation. It records the pending marker in review state and synchronizes one local posting intent per review before sending the request. The intent remains outside review artifacts after cleanup. It protects the remote side effect, not findings or decisions. After an uncertain result, the extension searches GitHub for the marker. If no review is found, it blocks another POST, including posts with changed content. An unresolved attempt also blocks cleanup. Legacy pending attempts without an intent cannot be submitted again without separate reconciliation. If GitHub might have accepted a request, cancellation cannot undo it. A failed session write blocks further review mutations in that Pi process until restart; ordinary Pi session entries still do not guarantee durability after every partial storage failure.

The extension binds posting work to the parent session. A session change requests cancellation of local work and prevents a late result from changing the replacement session. A cancellation request alone does not establish that a provider stopped or that cleanup finished.

## Current limits

A review covers one pinned pull request diff. It does not automatically start from a later commit, preserve cross-checkpoint finding status, collect standalone human code comments, or show an exact posting preview. The walkthrough requires an existing review ID; asking to open it does not create one. A local source does not grant GitHub posting authority. The extension does not implement code changes as part of a review.
