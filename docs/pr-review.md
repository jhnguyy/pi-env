# GitHub pull request review workflow

This note defines the user and safety contracts for the `pr-review` pi extension.

## User contract

The model-facing `pr_review` tool separates context retrieval from independent review creation.

Use `get` for existing pull request context or feedback work. The result includes the pull request description and GitHub feedback. Bounded pages report additional results or omissions. The shared total tool-output boundary applies without fixed limits on individual bodies.

Use `create` for a new independent review. Each run uses new child agent sessions with no parent conversation context. The `create` action does not post a GitHub review.

Within one parent session, `create` is idempotent for the same pull request and pinned head. An identical call opens the existing review. Use the explicit rerun command to create another attempt.

If an action has no URL, the extension resolves the current checkout pull request. If resolution fails, the agent asks the user for a URL.

The `get` action does not create a snapshot, worktree, child session, or managed review state. Pull request text is untrusted data.

## Independent review lifecycle

1. Resolve the GitHub pull request and fetch its metadata.
2. Fetch and verify the exact pull request head commit.
3. Compute and persist a pinned diff.
4. Create a detached managed worktree at the reviewed commit.
5. Start a fresh review agent through the shared subagent runtime.
6. Give the review agent only worktree-confined read tools and structured submission tools.
7. Validate the reading plan and findings against the pinned diff.
8. Store the review state in the parent pi session.
9. Let the user select, reject, or edit findings.
10. Post one review to GitHub only after an explicit user confirmation.

A changed remote head makes the review stale. The extension blocks posting until a fresh agent reviews the new head.

## Source and worktree contract

The source is a GitHub pull request. The extension uses `gh` for authentication and GitHub API access.

Extension-managed data lives below the pi agent directory:

```text
<agent-dir>/pr-review/
├── repos/<owner>/<repo>/
├── worktrees/<review-id>/
└── artifacts/<review-id>/
    ├── metadata.json
    └── diff.patch
```

The preparation step records the base commit, head commit, diff hash, changed-file manifest, and pull request metadata. All later stages use the persisted diff. They must not replace it with a live diff.

The review deck stores one shared metadata reference, one shared pinned-diff reference, and one canonical file table. Compact file IDs connect selected ranges to the file table. The deck does not repeat shared artifact identity for each file.

Repository cache operations use a per-repository lock. A successful review worktree remains available until explicit cleanup. If preparation fails before DAG submission, the extension removes the worktree and retains a bounded failed review record and artifacts for inspection.

## Fresh review agent

The existing subagent extension remains responsible for the child agent loop, child session persistence, parent linkage, cancellation, usage accounting, telemetry, and shutdown.

The subagent runtime exposes a lower-level service for callers that already resolved the model, system prompt, task, working directory, and tool instances. The review extension uses this service instead of asking the parent model to invoke the public `subagent` tool.

The default review model is the current parent model. A `prReview.model` setting can override it.

## Untrusted input boundary

Pull request content is untrusted. This includes source files, diffs, pull request text, comments, repository instructions, and project agent definitions.

The review child must not discover an agent definition from the reviewed worktree. The review extension supplies an inline system prompt.

The child receives no generic `bash`, `read`, `write`, `edit`, language-server, or analyzer tool. The extension creates run-scoped tools that enforce the managed worktree as their filesystem boundary:

- `review_read`
- `review_grep`
- `review_find`
- `review_list`
- `review_diff`
- `review_changed_files`
- `submit_review_plan`
- `submit_review`

The read tools reject path traversal and resolved paths outside the worktree. `review_diff` returns bounded file sections. `review_changed_files` pages the complete changed-file manifest. The agent does not receive the complete diff in its initial prompt.

The system prompt states that all reviewed material is data, not instructions. The child prompt guides the agent to use `review_changed_files` for the authoritative pinned changed-file manifest before selectively reading diffs and source.

## Structured review contract

The review agent first calls `submit_review_plan`. The plan contains:

- the pull request goal and goal assessment
- the risk level and reasons
- ordered conceptual cohorts
- each changed file exactly once
- an attention class for each file
- a short file role
- optional walkthrough and out-of-diff ripple notes

The submission tool rejects missing, duplicate, or invented changed paths. A failed submission returns exact correction information to the child agent.

The agent then calls `submit_review`. The result contains a bottom-line verdict and findings. Each finding contains:

- severity and goal-relative impact
- file and side
- line when available
- the problem
- the consequence
- a suggested fix

The extension validates anchors against the pinned diff. It preserves an invalid anchor as an unanchored finding instead of deleting the finding.

High-impact, blocking, and serious findings start selected. Other findings start unselected.

## Parent session state

The parent pi session stores review snapshots, agent run results, reviewer decisions, posting attempts, and cleanup state as custom entries. The extension reconstructs state from the active branch on `session_start` and `session_tree`.

The child session name includes the repository, pull request number, and reviewed head. The parent state records the child session file for inspection.

## Posting contract

Posting defaults to a GitHub `COMMENT` review. `APPROVE` and `REQUEST_CHANGES` require explicit user choices.

Before posting, the extension:

1. Fetches the current remote head.
2. Blocks if the head differs from the reviewed head.
3. Shows the event, target commit, bounded preface preview, and selected finding count.
4. Requires confirmation.

Generated comments include a visible AI disclosure. Reviewer-authored text remains distinguishable from generated text.

Each post attempt includes an invisible marker:

```html
<!-- pi-env-pr-review:<review-id>:<attempt-id> -->
```

If a post result is uncertain, the extension searches existing review bodies for the marker before it retries. This prevents a process failure between the remote post and local state update from creating a duplicate review.

## Command and tool surface

The tool manager activates `pr_review` for pull request review and feedback requests. The `/review` command remains the human-facing interface for the managed review lifecycle.

Use `/review list`, `/review open <review-id>`, and `/review cleanup <review-id>` when a session has multiple review records. A successful create returns the review ID and the exact open command.

## Deferred UI

A guided review walkthrough is intentionally deferred. The later UI will consume the same pinned snapshot, plan, findings, decisions, and posting state. The extension must not couple the core workflow to a specific layout.
