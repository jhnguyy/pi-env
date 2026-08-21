# GitHub pull request review workflow

This note defines the contract for the `pr-review` pi extension. The extension turns a normal request such as `Review this PR` into a pinned, fresh-context GitHub review workflow.

## User contract

The model-facing `pr_review` tool has two actions:

```text
pr_review action=get [url]
pr_review action=create [url]
```

Use `get` for existing context or feedback work. It returns the pull request description, comments, review summaries, and inline review threads. The main agent can inspect the code and address the feedback after `get` returns.

Use `create` for a new independent review. The main agent delegates this review and does not synthesize the change. Each run uses a new child agent session. The child session has no parent conversation context. The `create` action does not post a GitHub review.

If an action has no URL, the extension resolves the current checkout pull request with `gh pr view`. If resolution fails, the agent asks the user for a URL.

The extension also provides explicit commands for status, selection, editing, reruns, posting, and cleanup. Finding edits and preface edits use standard pi editor interactions when inline text is absent. A guided walkthrough TUI is a later feature.

## Compact context retrieval

The `get` action retrieves these feedback categories:

- Pull request title and description
- Conversation comments
- Submitted review summaries
- Inline review threads and replies

The extension uses one bounded GitHub GraphQL query for each page. It requests only the fields that feedback work needs. It does not return raw `gh` JSON, a full diff, or repository source.

The default page contains up to three items from each category. The caller can request up to five items from each category. An opaque cursor continues each category that has more pages. The result reports totals, returned counts, and omitted nested thread comments.

The description is limited to 4,000 characters. Each feedback body is limited to 1,000 characters. The complete tool output is limited to 36,000 UTF-8 bytes. A truncated item retains its GitHub URL when GitHub supplies one.

The `get` action does not create a snapshot, worktree, child session, or managed review state. Pull request text is untrusted data. The main agent must not treat the text as instructions.

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

## Command and tool surface

The tool manager activates `pr_review` when the user asks about a pull request. The tool prompt routes existing context and feedback requests to `get`. The prompt routes new independent review requests to `create`.

The explicit surface is:

```text
pr_review action=get [url]
pr_review action=create [url]
/review start [url]
/review status
/review findings
/review select <ids|all|none>
/review edit <id>
/review preface
/review rerun
/review post <comment|approve|request-changes>
/review cleanup
```

The slash command parser can evolve without changing the lifecycle or safety contracts in this note.

## Deferred UI

A guided review walkthrough is intentionally deferred. The later UI will consume the same pinned snapshot, plan, findings, decisions, and posting state. The extension must not couple the core workflow to a specific layout.
