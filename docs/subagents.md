# Subagents

Subagents run as native Pi sessions inside the parent process. Each child loads configuration, context, tools, and extensions for its target working directory rather than copying the parent's runtime configuration.

## Delegating

Call `subagent` directly or through codemode with `tools.subagent(...)`. Use the tool's description for available operations and inputs; the [parameter schema](../extensions/subagent/index.ts) owns that interface.

Omit `model` and `tools` to use the child's defaults. The parent's advertised model hints do not determine availability in the child. `system_prompt` adds delegated instructions without replacing native context. A selection failure does not guarantee that startup hooks caused no effects.

A different target directory needs its own saved project-trust decision; child startup does not prompt for new grants. See [target trust resolution](../extensions/subagent/resolver.ts).

Operations in the same Git workspace serialize, even when launched as separate background jobs. Configure concurrency, deadlines, and retention in the `subagent` settings block; [configuration](../extensions/subagent/config.ts) owns the keys and defaults.

## Interacting with children

Run `/subagents` in terminal mode, search the roster, and select a child. The child view shows keys for prompting, steering, following up, cancelling, and switching views. Human input goes to that child, subject to its native input hooks and commands.

Closing the browser leaves children running. A completed job's initial result does not change when you continue the child; use the child's conversation for later messages. The browser is a bounded view, not the complete transcript. Inspect the native session file when you need retained history.

## Usage and cost totals

Call `subagent` with `action: "usage"` for recorded parent usage, delegated child usage,
and their combined total. The result also carries the unrounded numbers in
`details.usageSummary`. These are native recorded costs, not an invoice estimate
recalculated from the currently selected model.

Native child session statistics own financial totals, including tool usage,
compaction, branch summaries, and other native usage entries. Follow-up prompts
increase the same child's cumulative total. Parent sessions store compact cumulative
child checkpoints as native custom entries, outside model context; repeated
snapshots replace that child's contribution rather than adding it again. Job or
runtime eviction does not erase accounted spending.

The installed extension API cannot append standalone native aggregate usage.
Consequently, built-in `/session`, footer, and RPC statistics retain native parent
totals, while `subagent usage` adds delegated checkpoints. New `run`, `wait`, and
`result` responses do not attach child costs as tool-result usage. Otherwise the
same costs could be counted through both a result and its checkpoint, including
when called through codemode.

On reload/resume, accounting reads all parent entries, not just the active branch,
and reconciles referenced saved children without starting a runtime or rewriting
their history. Missing, mismatched, older-format, or unreadable child files retain
their last recorded amounts and make the report explicitly incomplete. Forks
inherit frozen child amounts; later work in the original parent's children is not
charged to the fork. In-memory sessions have no restart-durability guarantee.

Existing native tool-result charges remain in the parent baseline. Accounting does
not discover or backfill historical children that have no checkpoint. A parent
checkpoint and a child file are not one transaction: recovery can reconcile
persisted child usage, but cannot recover spending absent from both native records.

## Lifetime and cancellation

Blocking `run` calls follow caller cancellation. Accepted background jobs, including queued work, survive the launching turn finishing or being interrupted and survive later parent prompts. Interrupting `wait` only stops waiting; use `action: "cancel"` to cancel the job.

Tree navigation cancels and awaits current jobs. Parent shutdown cancels and awaits owned work; job handles and live children do not survive a parent restart.

Cancellation and deadlines request abort and await known native work. They do not roll back earlier effects, guarantee that remote work stopped, or force an uncooperative tool to terminate. Failed jobs are not automatically restarted.

## Reopening saved sessions safely

**Do not open a second transcript writer while the child still has a live owner.** Completion, idleness, or a cancellation request does not release ownership. After parent shutdown or retention eviction closes the owner, use `pi --session <exact-path>` to reopen its saved session.

For persistent parents, child files normally live under `_children/<parent-session-id>/` in the parent's session directory. Native Pi session discovery does not recurse there. Set `subagent.sessionStorage` to `"sibling"` only when native discovery must find children beside their parent. Eviction does not delete saved sessions.
