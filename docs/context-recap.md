# Context recap

**Draft blocker:** root TUI recap customization is implemented; the proposed automatic timer is not safe to implement with Pi 1.5's public API. This remains a draft, not an automatic-recap release.

The `context-recap` extension replaces native compaction summaries in root TUI sessions. Loading it enables summary customization, including `/compact` and native threshold/overflow compaction. It does not change Pi's compaction thresholds or retained-history budget. Child sessions, RPC, print, and JSON mode keep native behavior.

After building with `nub run build`, reload or restart Pi to load the bundle. See [extension conventions](conventions/extensions.md) for package loading and the [installed Pi compaction reference](../node_modules/@earendil-works/pi-coding-agent/docs/compaction.md) for native retention settings.

## Commands

```text
/context-recap status
/context-recap now
/context-recap cancel
```

- `status` reports that root TUI recap customization is active and automatic recap is blocked.
- `now` requests ordinary native compaction only when Pi reports idle with no queued messages. It uses the selected model and can incur an inference charge. **Do not submit another prompt until compaction finishes:** the check is not an atomic reservation, and native manual compaction aborts current work first.
- `cancel` interrupts recap generation while this extension's compaction handler is active; otherwise it does nothing. Once that handler returns a proposal, `cancel` reports no active recap even if a later extension handler is still running. It does not abort ordinary agent work or disable recap customization. Unload the extension to restore native summaries.

There is no extension configuration, retention profile, or automatic-mode toggle. Status does not read settings.

## Recap contract

The prompt targets 400–700 words, with a hard validation cap of 24,000 characters. Each summary contains `Objective`, `Plan and Progress`, `Remaining Work`, and `Information Sources`. The request asks the model to retain goals, constraints, approval boundaries, decisions and rationale, verification evidence versus assumptions, blockers, and pending actions. Information sources should identify authoritative navigation and task-critical locations, not inventory every file touched. These are model instructions, not a guarantee of semantic completeness; inspect important recaps before relying on them.

The request includes Pi's prepared history, split-span prefix, and previous summary. For orientation only, it also includes the last eight projected retained entries, serialized and clipped to the last 6,000 characters. Projection honors context edits rather than resurrecting raw omitted messages. Native serialization omits thinking and truncates tool results; missing details may require consulting authoritative sources.

The extension preserves `firstKeptEntryId`, `tokensBefore`, and recent history. Pi persists the recap and usage and maintains the system-prompt/tool checkpoint. The extension does not add native read/modified-file inventories.

Before calling the provider, the extension checks the complete composed prompt against the selected model's positive, safe-integer `contextWindow` and `maxTokens` metadata. Its conservative admission budget charges one unit per UTF-8 input byte, reserves the output allowance, and adds headroom of the larger of 2,048 units or 10% of the context window. This is a heuristic, not a guaranteed token estimate or proof of provider acceptance. Invalid limits or an oversized budget cancel compaction without a provider request. The extension does not trim history, the split prefix, previous summary, or operator instructions to fit this budget; the native serialization limits described above still apply.

One request uses `ctx.modelRegistry.complete` with `cacheRetention: "none"`, an output cap of 4,096 tokens (or the model's smaller limit), and a 60-second deadline. Through the recap handler's final check, aborts and relevant input, run, model, thinking, tree, session, and UI-prompt changes invalidate a pending recap, and a changed branch leaf rejects its proposal. This protection is not atomic through native commit: later compaction handlers can await work after recap returns. A late lifecycle change cannot retract the returned proposal; Pi checks its own compaction abort signal before saving, not this extension's generation or leaf. Native compaction abort can still stop that commit. Empty, malformed, oversized (over 24,000 characters), tool-calling, error, aborted, or length-limited responses cancel compaction. There is no native fallback or extension retry that could make a second billing request. A provider that ignores cancellation may still complete or bill its underlying request; the extension stops waiting and never saves that response. Failed attempts may still incur charges, even though no successful recap usage entry is saved. Failure notifications distinguish model limits, admission budget, response contract, deadline, cancellation, and provider failures with actionable guidance. They never include caught provider error text or response content.

## Why automatic mode is unavailable

Pi 1.5's public `ctx.compact()` delegates to manual compaction, which awaits `abort()` before acquiring compaction state. A new prompt can start after an idle check but before that acquisition. The deterministic native SDK test in [native.integration.test.ts](../.pi/extensions/context-recap/__tests__/native.integration.test.ts) observes `session.isStreaming` and a blocked, un-aborted provider request inside the compaction hook, even without an `await` between the idle check and `compact()`. A no-prompt control observes no streaming while `ctx.isIdle()` is still false: compaction alone makes that idle check false. This proves overlap, not that the newly started prompt is aborted; a separate test establishes that native compaction aborts already-running work. Lifecycle invalidation cannot make that acquisition atomic. Prompt replay would introduce different semantics and possible extra charges, so this extension does not use it.

Cache lifetime metadata is an estimate, not an observable expiry deadline. Recap generation uses a separate serialized prompt with cache writes disabled; running before conversation-cache expiry does not establish cache reuse or savings.

Consequently, this version has **no automatic scheduler**, including after resume or reload, and does not interfere with native cache warming. Timer qualification requires an upstream atomic idle-only compaction API. The deferred policy is opt-in: one unreferenced timer after a fresh successful real turn's final `agent_settled`, anchored conservatively at `turn_start`; exact model retention metadata; at least 30,000 context tokens; a lead of `max(30 seconds, 10% of TTL)`; and no action after expiry or a missed sleep window. It must invalidate on activity, recheck model/branch/generation and idle/queue state, suppress itself when native idle cache warming is enabled, and never loop or retry. None of those timer behaviors is claimed as implemented support.

## Verification boundary

Focused units cover request composition, pre-request context admission, response validation, cancellation, and deadlines. Isolated native SDK integration uses deterministic inference and temporary agent/session directories to check persistence, recent-history/checkpoint preservation, no fallback, lifecycle cancellation through recap's handler, late-handler/native-abort behavior, and the acquisition race with a no-prompt control. This is not hosted-provider, real-terminal rendering, or future atomic-API timer qualification.
