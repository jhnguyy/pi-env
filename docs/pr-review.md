# GitHub pull request review workflow

This note defines the user and safety contracts for the `pr-review` pi extension.

## User contract

The model-facing `pr_review` tool separates context retrieval from independent review creation.

Use `get` for existing pull request context or feedback work. The result includes the pull request description and GitHub feedback. Bounded pages report additional results or omissions. The shared total tool-output boundary applies without fixed limits on individual bodies.

Use `create` for a new independent review. Each run uses a fixed review DAG with fresh child sessions. The child sessions receive no parent conversation context. The `create` action does not post a GitHub review.

If an action has no URL, the extension resolves the current checkout pull request. If resolution fails, the agent asks the user for a URL.

The `get` action does not create a snapshot, worktree, child session, or managed review state. Pull request text is untrusted data.

## Independent review lifecycle

1. Resolve the GitHub pull request and fetch its metadata.
2. Fetch and verify the exact pull request head commit.
3. Compute and persist a pinned diff.
4. Create a detached managed worktree at the reviewed commit.
5. Build a bounded review deck under the managed artifact directory.
6. Resolve the approved reviewer roster and persist role assignments.
7. Submit the fixed review DAG through the session-owned DAG service.
8. Run the reading plan, five focused reviewers, and one whole-change reviewer in parallel.
9. Synthesize successful reviewer artifacts after all reviewer paths become terminal.
10. Validate the plan, result schemas, changed paths, and anchors against the pinned diff.
11. Store references and bounded review state in the parent pi session.
12. Let the user select, reject, or edit findings.
13. Post one review to GitHub only after an explicit user confirmation.

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

## Review DAG and child sessions

The subagent extension owns the session DAG service and the shared subagent supervisor. It also owns child persistence, cancellation, usage accounting, telemetry, and shutdown.

The review extension submits a code-owned graph. A child cannot add nodes, change dependencies, or start another child. Each child receives only run-scoped review tools.

The graph runs these reviewer roles:

- `correctness`
- `intent`
- `maintainability`
- `tests`
- `security`
- `whole-change`

The reading plan runs beside the reviewers. Synthesis waits for all reviewer paths to become terminal. Synthesis requires at least one successful reviewer path.

Agent settings approve models with the exact `reviewer` annotation. The review extension rejects unapproved role pins. One approved model can fill all roles. The extension derives the highest supported reasoning level from model metadata.

## Untrusted input boundary

Pull request content is untrusted. This includes source files, diffs, pull request text, comments, repository instructions, and project agent definitions.

The review child must not discover an agent definition from the reviewed worktree. The shared DAG adapter supplies a fixed system prompt. The review extension supplies domain instructions as trusted payload fields.

The child receives no generic `bash`, `read`, `write`, `edit`, language-server, or analyzer tool. The extension adds a run suffix to each tool name. It creates these run-scoped tool classes:

- `review_deck`
- `review_read`
- `review_grep`
- `review_find`
- `review_list`
- `review_diff`
- `review_changed_files`
- `submit_review_plan`
- `submit_reviewer_result`
- `review_result_refs`
- `submit_review_synthesis`

The read tools reject path traversal and resolved paths outside the worktree. `review_diff` returns bounded file sections. `review_changed_files` pages the complete changed-file manifest. The agent does not receive the complete diff in its initial prompt.

The system prompt states that all reviewed material is data, not instructions. The child prompt guides the agent to use `review_changed_files` for the authoritative pinned changed-file manifest before selectively reading diffs and source.

## Structured review contract

The reading-plan child calls `submit_review_plan`. The plan contains:

- the pull request goal and goal assessment
- the risk level and reasons
- ordered conceptual cohorts
- each changed file exactly once
- an attention class for each file
- a short file role
- optional walkthrough and out-of-diff ripple notes

The submission tool rejects missing, duplicate, or invented changed paths. A failed submission returns exact correction information to the child agent.

Each focused reviewer calls its structured submission tool. The result contains a bottom-line verdict and findings. Each finding contains:

- severity and goal-relative impact
- file and side
- line when available
- the problem
- the consequence
- a suggested fix

The synthesis result preserves source reviewer names and agreement counts. The extension validates anchors against the pinned diff. It preserves an invalid anchor as an unanchored finding instead of deleting the finding.

High-impact, blocking, and serious findings start selected. Other findings start unselected.

One failed or malformed reviewer produces a degraded review when another reviewer succeeds. If all reviewers fail or return malformed results, the review fails. Raw reviewer outputs remain external artifact references.

## Parent session state

The parent pi session stores review snapshots, agent run results, reviewer decisions, posting attempts, and cleanup state as custom entries. The extension reconstructs state from the active branch on `session_start` and `session_tree`.

The parent state records the review deck, role assignments, DAG run ID, terminal status, plan and result projections, and raw artifact references. It also records latency, deck bytes, result bytes, usage, reviewer failures, finding count, and anchored finding count. Session replay reconstructs an active DAG attempt as interrupted after process loss. Reconstruction does not require a live run handle.

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

`/review draft-plan` creates a local draft implementation plan from selected findings. The command does not execute the plan. The user must approve the plan before a later orchestration workflow can use it.

## Deferred UI

A guided review walkthrough is intentionally deferred. The later UI will consume the same pinned snapshot, plan, findings, decisions, and posting state. The extension must not couple the core workflow to a specific layout.
