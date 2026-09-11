# Review workflow

This note defines the pull request user and safety contracts for the `review` pi extension.

## User contract

The model-facing `review` tool separates review subjects from their actions. Use `review pr get` or `review pr create` for pull request work.

Use `review pr get` for existing pull request context or feedback work. The result includes the pull request description and GitHub feedback. Bounded pages report additional results or omissions. The shared total tool-output boundary applies without fixed limits on individual bodies.

Use `review pr create` for a new independent review. Each run uses new child agent sessions with no parent conversation context. The `create` action does not post a GitHub review.

Within one parent session, `create` is idempotent for the same pull request and pinned head. An identical call opens the existing review. Use the explicit rerun command to create another attempt.

If an action has no URL, the extension resolves the current checkout pull request. If resolution fails, the agent asks the user for a URL.

The `review pr get` action does not create a snapshot, worktree, child session, or managed review state. Pull request text is untrusted data.

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

The preparation step records the base commit, head commit, diff hash, changed-file manifest, and pull request metadata. All later stages use the same bounded, hash-verified snapshot reader. It rejects non-regular files and diffs above 8,000,000 bytes before allocation. No stage substitutes a live diff.

The review deck stores one shared metadata reference, one shared pinned-diff reference, and one canonical file table. Compact file IDs connect selected ranges to the file table. The deck does not repeat shared artifact identity for each file.

Repository cache operations use a per-repository lock. A successful review worktree remains available until explicit cleanup. If preparation fails before DAG submission, the extension removes the worktree and retains a bounded failed review record and artifacts for inspection.

## Review DAG and model policy

The review extension submits one fixed graph through the session-owned DAG service. The graph contains a reading-plan node, a deterministic evidence resolver, five focused reviewers, one whole-change reviewer, and one synthesis node. The subagent extension owns child execution, sessions, cancellation, usage, telemetry, and shutdown.

The evidence resolver uses `DagExecutorKind.Materialize` with key `pr-review/evidence-resolver-v1`. The review extension registers this executor for the active session generation. The session runtime removes registered domain executors during generation disposal.

A model is eligible only when `modelAnnotations` contains the exact `reviewer` annotation for its fully qualified ID:

```json
{
  "modelAnnotations": {
    "provider/model": ["reviewer"]
  }
}
```

One approved model can fill every role. Optional `prReview.roleModels` entries can pin `reading-plan`, `correctness`, `intent`, `maintainability`, `tests`, `security`, `whole-change`, or `synthesis`. Each pinned model must have the exact annotation and must be available. The obsolete `prReview.model` setting has no effect.

The runtime measures aggregate input, output, cache, cost, and turn usage across all review children and their nested model work. It reports this usage in live progress, persisted review metrics, and the final structured result. The runtime does not enforce aggregate token, cost, or turn budgets. Reviewer nodes set the node-local `maxTurns: 1` boundary.

Each review child uses its durable child-session ID as the provider session ID. Providers can use this ID to reuse a streaming connection and send incremental context across the child’s turns.

Pi computes a usage tree recursively. Each subagent result includes its own assistant usage plus nested tool usage. The calling session adds that nested total to its own assistant usage. Repeated review reuse and repeated asynchronous job retrieval do not add the same nested usage again.

Interactive review tools publish structured progress updates about every two seconds. The top-level `review` tool projects the fixed graph into `planning`, `reviewing`, and `synthesizing` phases. Active review phases show the running reviewer roles. The progress view shows aggregate cost when usage data is available. Internal review subagents do not add child tool rows to the parent transcript.

Partial updates store cumulative aggregate usage in result details. They do not set top-level tool usage. The terminal result reports nested usage once so that Pi does not count repeated progress snapshots.

The collapsed terminal result shows the verdict, aggregate cost when available, and the exact review ID. It normalizes and bounds the verdict. It does not show turn counts, token counts, model names, findings, snapshot metadata, or DAG run IDs. The expanded result keeps the complete verdict and the detailed review result. An idempotently reused review labels its persisted value as recorded cost. Noninteractive `pi -p` output shows only the final result.

## Untrusted input boundary

Pull request content is untrusted. This includes source files, diffs, pull request text, comments, repository instructions, and project agent definitions.

The review child must not discover an agent definition from the reviewed worktree. The review extension supplies an inline system prompt.

A child receives no generic `bash`, `read`, `write`, `edit`, language-server, analyzer, network, or spawn tool. The reading-plan child receives run-scoped review tools for these operations:

- page the pinned title and body;
- read selected source line ranges;
- page the pinned diff or one file section;
- page the complete changed-file manifest;
- list, find, and fixed-string search within the worktree;
- read the bounded review deck;
- submit a reading plan or synthesis;
- load verified reviewer result references during synthesis.

One immutable diff index owns canonical rename, deletion, repeated-section, hunk-range, and side-specific anchor semantics. Each walkthrough loads this verified index once, on first evidence inspection. It pages the admitted content without rereading the diff. Reopening the walkthrough verifies the persisted file again. The deck, diff reader, and evidence resolver consume this index. The deck file table contains compact line ranges for every pinned diff hunk. The reading plan uses these ranges to produce strict file and pinned-diff references without one tool call for each changed path. Each selected diff range must contain a complete hunk. The reading plan prioritizes hunks under the dossier limit. The deterministic resolver validates snapshot identity, paths, ranges, containment, changed-hunk coverage, and admission limits. It records exact uncovered hunks as omissions and makes final coverage degraded. It publishes one coverage record and bounded evidence chunks. Every reviewer consumes the same coverage digest and chunks through normal DAG context materialization.

Reviewer nodes receive no tools. Each reviewer sets `maxTurns: 1` and returns one direct JSON object. The parent validates the role, evidence digest, schema, findings, provenance, and anchors. Synthesis keeps the bounded result-reference and submission tools.

Filesystem tools reject path traversal and resolved paths outside the worktree. Metadata access does not expose a filesystem path. Diff and metadata tools return a `nextOffset` when more content remains. The child does not receive the complete diff in its initial prompt.

The system instructions state that reviewed material is data. Each child must inspect the deck and use only its assigned run-scoped tools.

## Structured review contract

The reading-plan node submits the pull request goal, goal assessment, risk, conceptual cohorts, one file entry for every changed path, and a bounded evidence index. The submission rejects missing, duplicate, invented, reversed, or unplanned references.

Each reviewer returns its fixed role, evidence digest, verdict, and findings. Each finding contains severity, goal-relative impact, optional anchor, problem, consequence, and suggested fix.

The synthesis node reads one admitted reviewer dossier. The dossier verifies artifact identity, output names, schema, roles, and evidence digests. It classifies failed and malformed reviewers once. Synthesis and terminal finalization consume the same admission result.

For new runs, the harness assigns a stable opaque ID to every admitted raw finding occurrence. IDs are scoped to the source role, admitted evidence digest, original finding, and occurrence. Identical occurrences remain separate. The bounded synthesis context includes these IDs and unchanged raw finding payloads without duplicating the full reviewer transcript text.

Synthesis uses the version 2 editorial consolidation contract. A retained finding can group and rephrase one or more raw findings by ID. Every admitted raw ID must occur exactly once, either in one retained group or in one dismissal with a nonblank reason. Trusted code derives source roles in deterministic role order and agreement as the number of distinct represented roles. It does not accept model-authored provenance, infer dissent from silence, or treat editorial consolidation as verified correctness.

Parent state stores each admitted raw finding's compact ID, role, evidence digest, occurrence index, existing verified reviewer DAG artifact reference, retained raw ID references, and dismissal reasons. It does not copy finding payloads or create per-finding artifacts. Lazy raw inspection reuses the dossier materializer and admission rules, then verifies the reviewer role, evidence digest, occurrence index, and raw ID before returning bounded content. Invalid, incomplete, malformed, or unavailable consolidation degrades the review and falls back to one result finding per admitted raw occurrence. Fallback does not deduplicate identical findings and does not admit content from rejected reviewer outputs.

The legacy unversioned exact-text synthesis schema remains readable only when reconstructing historical terminal DAG artifacts whose persisted DAG state has no synthesis protocol marker. New runs persist `synthesisProtocol: 2` before graph submission and preserve it through later snapshots. Marked version 2 runs never reinterpret malformed output as legacy output. Unknown markers fail safely to fallback. Legacy states without version 2 provenance remain readable and do not receive fabricated raw IDs, dismissals, source roles, or agreement.

The extension validates anchors against the pinned diff. It preserves an invalid anchor as an unanchored finding. For new decision-enabled runs, impact and severity classifications are machine recommendations. Posting selection requires an explicit human decision.

## Parent session state

The parent pi session stores review snapshots, agent run results, reviewer decisions, posting attempts, and cleanup state as custom entries. A session-scoped review coordinator owns mutable workflow state, in-flight operations, lifecycle guards, posting serialization, and evidence-executor registration. The extension reconstructs state from the active branch on `session_start` and `session_tree`.

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

If a post result is uncertain, the extension searches existing review bodies for the marker before it retries. This prevents a process failure between the remote post and local state update from creating a duplicate review. The pending marker is persisted before submission so replay can reconcile an interrupted result.

Late results update only the original posting attempt. They preserve newer human edits and do not recreate a cleaned review. Posting changed content still requires confirmation.

Posting is bound to the parent session generation. A session change cancels local waits and process work and prevents completion state from being written into the replacement session. Cancellation cannot revoke a request after GitHub may have accepted it. In that case the original session's pending attempt remains the reconciliation authority and the result is reported as potentially accepted, not undone.

## Command and tool surface

The tool manager activates `review` for pull request review and feedback requests. The `/review` command remains the human-facing interface for the managed review lifecycle.

Use `/review pr list`, `/review pr open <review-id>`, and `/review pr cleanup <review-id>` when a session has multiple review records. A successful create returns the review ID and the exact open command.

## Guided walkthrough and human decisions

Use the explicit review ID for every walkthrough mutation:

- `/review pr walkthrough <review-id>` opens a compact overview, ordered reading-plan, finding, and provenance flow. Every planned file remains reachable and exposes bounded pages from the persisted, hash-verified diff. Findings expose consequence, suggested fix, pinned anchor context when available, and select, reject, defer, or edit actions.
- `/review pr select <review-id> <finding-id>...`
- `/review pr reject <review-id> <finding-id>...`
- `/review pr defer <review-id> <finding-id>...`
- `/review pr edit <review-id> <finding-id>`
- `/review pr preface <review-id>`

Human decisions are durable `pending`, `selected`, `rejected`, or `deferred` records. Missing decisions, including machine defaults and legacy selected IDs, remain pending and are not human inspection. New decision-enabled reviews post only explicitly selected findings. Headless walkthroughs are bounded and read-only.

Posting remains the only remote authority. Use `/review pr post <review-id> [comment|approve|request-changes]` to target the inspected review exactly. The legacy `/review pr post [comment|approve|request-changes]` form remains a compatibility boundary that targets the currently opened review. Both forms use the same stale-head, content revalidation, confirmation, marker, and retry implementation. The confirmation shows event, head, selected IDs, bounded preface, and an explicit warning when coverage is degraded.
