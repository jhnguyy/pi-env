# GitHub pull request review workflow

This note defines the initial contract for the `pr-review` pi extension. The extension turns a normal request such as `Review this PR` into a pinned, fresh-context GitHub review workflow.

## User contract

The primary entry point is a normal pi prompt:

```text
Review this PR https://github.com/owner/repo/pull/123
```

If the prompt has no URL, the extension can resolve the pull request for the current checkout with `gh pr view`. If no pull request can be resolved, the agent asks the user for a URL.

The main pi agent delegates the review. The main agent does not inspect or synthesize the change itself. Each run uses a new child agent session with no parent conversation context.

The extension also provides explicit commands or tool actions for status, finding selection, editing, reruns, posting, cleanup, and a TUI walkthrough. Finding edits and preface edits use standard pi editor interactions when inline text is not supplied. `/review walkthrough` is available only in TUI mode. Other modes receive a concise fallback and no custom component is opened.

## Review lifecycle

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

Repository cache operations use a per-repository lock. A review worktree remains available until explicit cleanup.

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

## Initial command and tool surface

The model-callable start tool has a direct description and prompt guideline. The tool manager activates it when the user asks to review a pull request in natural language.

The initial explicit surface is:

```text
/review start [url]
/review status
/review findings
/review select <ids|all|none>
/review edit <id>
/review preface
/review rerun
/review post <comment|approve|request-changes>
/review cleanup
/review walkthrough
```

The exact parser can evolve without changing the lifecycle or safety contracts in this note.

## Walkthrough TUI

`/review walkthrough` opens a focused, non-overlay TUI over the latest active review. Each opening reads the persisted pinned diff once, verifies its SHA-256, and derives bounded context for every declared valid finding anchor. If the diff artifact is unreadable, the hash mismatches, or any valid anchor cannot be extracted, the walkthrough fails closed and does not open. The walkthrough never refreshes context from live Git.

The component is pure view/navigation. Left and Right move between sections. Up, Down, and Page keys scroll the current section. Component keys close with durable intents only: selection, finding edit, preface edit, rerun, post, child inspection, cleanup, help, or close. The command handler then runs the existing shared action or standard Pi dialog and reopens from `getLatestReviewState()`. Selection is stored only in `selectedFindingIds`. Component navigation appends no review state.

Posting from the walkthrough requires an explicit event choice: `COMMENT`, `APPROVE`, or `REQUEST_CHANGES`. The existing final post confirmation, stale-head check, idempotence marker, and uncertain-result guard remain authoritative. A complete plan and result are required before posting. Zero findings is valid and can approve. Empty comment and request-changes posts remain blocked by the core posting rules.

If the child run is incomplete or failed, the walkthrough opens only an overview/finalize-safe view. It still allows rerun, child inspection when exact session metadata exists, and cleanup. It does not guess missing child metadata. Cleanup uses a walkthrough-local confirmation before invoking the shared cleanup action.
