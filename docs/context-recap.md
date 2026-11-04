# Context recap

The `context-recap` extension customizes native compaction summaries in root TUI sessions. Automatic pre-expiry recap is **opt-in and off by default**. Child sessions, RPC, print, and JSON modes keep native behavior. Pi still owns compaction thresholds, retained-history selection, queues, persistence, and cache warming.

After `nub run build`, reload or restart Pi. See [extension conventions](conventions/extensions.md) and the [installed Pi compaction reference](../node_modules/@earendil-works/pi-coding-agent/docs/compaction.md).

## Commands

```text
/context-recap on
/context-recap on 5m
/context-recap off
/context-recap status
/context-recap now
/context-recap cancel
```

- `on` enables scheduling only after a future fresh successful real run settles. Restored history never arms a timer. A known model uses each request's cache lifetime dynamically.
- `on <duration>` supplies a **user-estimated lifetime, not a cache guarantee**, for an unknown endpoint/current model. Units are `s`, `m`, and `h`; the lifetime must exceed 30 seconds and fit a native timer. It cannot override a request that explicitly disables caching. Changing models discards the estimate, including endpoint applicability. Commands do not persist settings.
- `off` disables scheduling and signals local recap inference cancellation. Summary customization remains active; unload the extension to restore native summaries.
- `status` reports mode, scheduled target time, TTL and source, or the suppression reason. During an owned operation it reports acquiring, generating, or handed-off, including pending cancellation.
- `now` requests native compaction only when idle with no queued messages or blocking UI. It works independently of cache metadata and warming settings and can incur an inference charge.
- `cancel` consumes the timer candidate, invalidates pending acquisition, and signals local inference cancellation without aborting ordinary agent work. Once the proposal has been handed to Pi, an extension-owned operation reports that it cannot retract the proposal; native Esc can cancel compaction. Native `/compact` attempts not launched by this extension do not carry its reservation.

## Scheduling and input ownership

One unreferenced timer follows a fresh successful final assistant response with no tools, error, or abort and a matching physical model. `turn_start` captures a conservative early time estimate with unknown lifetime; `before_provider_request`, when invoked by the transport, refines that anchor and supplies cache facts without retaining the payload. Custom transports that omit the payload hook can schedule only with an explicit current-model user estimate. The fallback anchor does not establish that a network request was sent or caching occurred; the successful final physical-model check still applies. Explicit payload caching-off always suppresses scheduling, even with an estimate. Lead time is `max(30 seconds, 10% of lifetime)`. The target is request time plus lifetime minus lead; the latest launch is target plus half the lead. Settlement after the target, short lifetimes, late wakeups, and backwards clock movement skip the attempt. There is no context-size minimum, polling, self-rearming, or retry.

Activity invalidates the candidate: input, new runs, model/thinking changes, user bash, blocking UI, session/tree changes, compaction, and shutdown. Launch rechecks idle state, queued messages, UI state, generation, session, branch, model/endpoint, and thinking level. The latest observed input preflight blocks scheduling and `now` until it reaches run start. Consumed input or failed authentication does not accumulate historical debt: a later ordinary input and successful current-model run with no newer input restores eligibility, even with automatic mode off. Input during a run suppresses that settlement; a later clean run recovers. Native idle, `on`, and `status` alone do not resolve a suspended latest preflight.

The scheduler installs its own completion reservation immediately before calling public `ctx.compact()`, on the same JavaScript stack. The input hook synchronously invalidates the candidate and cancels owned inference before any await or later input/authentication handlers. Reservation cancellation survives delayed compaction-hook entry, so an invalidated reservation makes no recap provider request. Input waits for native terminal callbacks and then continues unchanged. A secondary `before_agent_start` gate protects input-bypassing starts that reach it; native `_prepareRun` checks for compaction before that hook, so it cannot guarantee all SDK resumes. Neither gate calls native `waitForIdle()` or broad `abort()`. The reservation lasts through later compaction handlers and native commit, not just recap generation. Shutdown releases waiters without waiting for compaction.

After native TUI compaction acquisition, InteractiveMode owns ordinary submission queuing and dispatches it after completion. The extension does not intercept raw keys, copy/replay prompts, consume input, or broadly abort work to restore a queue. This safety scope relies on the ordinary TUI main loop awaiting `session.prompt` before accepting the next normal idle input; it does not inventory arbitrary concurrent SDK callers or extension-command operations. Earlier-loaded blocking input handlers are invisible until they pass control to this extension: package order is not universal handler priority. Direct SDK native `compact()` calls outside this extension's reservation can still overlap a same-stack prompt; the retained SDK race qualification describes that unguarded native behavior.

Automatic recap yields to **global** `cacheWarming: "idle"`. The shared settings boundary reads a snapshot at arming and launch, decoding the global warming setting once per snapshot; project settings do not own this native mode. Uncertain reads suppress automatic recap with an actionable, allowlisted reason. The extension neither overrides warming decisions nor changes retention.

## Cache lifetime facts

These are scheduling lifetimes, not observable eviction/deletion deadlines or guarantees of a cache hit. Metadata is inspected only at `before_provider_request`; request payloads and credentials are not retained or logged. Later extensions can still change the outgoing payload. Only actual cache-control envelopes participate: Anthropic top-level, system blocks, direct tool definitions and message content blocks; OpenAI input content breakpoints. Nested schema/argument properties or sample user JSON do not participate. A different outgoing `model` is unknown rather than inheriting the selected model's compatibility.

| Request                                                                                | Scheduling lifetime                                                                                                                                                  |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic Messages `cache_control: {type: "ephemeral"}`                                | 5 minutes when `ttl` is absent or `5m`; 1 hour for `1h`; shortest applicable breakpoint wins                                                                         |
| Public `https://api.openai.com` Responses with `supportsExplicitPromptCacheMode: true` | `prompt_cache_options.ttl` of `30m` or `12h`; omitted TTL/automatic mode defaults to 30 minutes; per-breakpoint TTLs participate in the shortest applicable lifetime |
| OpenAI explicit mode without an actual `prompt_cache_breakpoint`                       | Caching off; no timer                                                                                                                                                |
| Earlier OpenAI `prompt_cache_retention: "24h"`                                         | Unknown; not a literal 24-hour expiry deadline                                                                                                                       |
| Codex, unknown endpoints or ambiguous metadata                                         | Unknown; skip unless the user supplies a current-model estimate                                                                                                      |

Model `promptCache` tiers alone do not reveal which retention tier the final request used; the extension does not guess from them. Sources: [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

## Fidelity and inference contract

Each complete recap has four nonempty sections: `Objective`, `Plan and Progress`, `Remaining Work`, and `Information Sources`. Instructions preserve goals, constraints, approvals, decisions and rationale, verification versus assumptions, blockers, and pending work. They guide the model but cannot guarantee semantic completeness; inspect consequential recaps.

The request includes all prepared history, split-span prefix, previous summary, operator instructions, and full edited projected retained-tail orientation. There are no extension word, character, orientation-entry, or fixed output caps. Native `serializeConversation` intentionally omits thinking and limits each tool result to 2,000 characters. No other source is silently trimmed.

Native exported `estimateTokens` estimates the complete composed prompt. The output allowance is the smaller of model `maxTokens` and remaining context capacity after a 512-token framing reserve. This estimate is approximate, not a provider-tokenizer guarantee. Invalid model limits or exhausted capacity cancel before inference. One selected-model request asks for no cache writes with `cacheRetention: "none"` where supported; legacy OpenAI implicit caching is not fully disabled by this option. There is no extension total-generation deadline: healthy long streams can finish. Native transports use idle/stall timeouts (managed setup configures 120 seconds idle), but arbitrary SDK/custom transports do not inherit a blanket stall guarantee. `modelRegistry.complete` does not use native summarization's retry wrapper; the extension adds no retry.

The extension preserves native `firstKeptEntryId`, `tokensBefore`, retained history, checkpoint, and usage persistence. Empty, malformed, tool-calling, error, aborted, and length-limited responses cancel without native fallback or another extension request. Failure messages never include caught provider text. Combined native and lifecycle abort signals race the request, with listener cleanup and a post-result cancellation check. A provider ignoring abort may still complete or bill; the extension stops waiting and does not save its late response. Lifecycle cancellation cannot retract a proposal already returned to later native handlers; Pi's compaction signal remains authoritative through commit.

## Cost and recommendation

Pre-expiry recap is an optional **fidelity feature, not a guaranteed saving**. Its serialized prompt does not guarantee reuse of the conversation's old prefix. It adds a summary request and can be expensive if the session is never resumed. Manual recap or leaving automatic mode disabled are valid choices. No economic predictor, extra probing calls, or retention changes are added.

Pi's native warmer owns its economic decision: `p × (cache miss cost − cache hit cost) − warm cost >= $0.05`, using idle continuation probability `p = 0.15`. This extension does not duplicate that decision.

For a stable prefix, long-retention fresh-write break-even relative to short writes is `m > (wl − ws) / (ws − r)`, where `m` counts qualifying avoided misses, `wl`/`ws` are long/short write rates, and `r` is the read rate. Using estimated nominal API rate multipliers:

- Anthropic Sonnet 4.6: short `1.25×`, long `2×`, reads `0.1×`; one delayed resume needs probability above **65.2%** to offset the longer write.
- New OpenAI caching: 30-minute writes `1.25×`, 12-hour writes `2.5×`, reads `0.1×`; break-even requires more than **1.087** qualifying avoided misses. One delayed reuse is insufficient; two can pay.

These comparisons concern retention pricing for identical prefixes, not recap savings. Subscription billing and model-specific rates can differ from nominal API estimates.

## Verification boundary

Deterministic timer units cover one-shot scheduling, activity reset, missed windows, envelope-only TTL decisions, warming suppression, busy/queued guards, early and in-flight gate cancellation, reservation callback ownership, recovery, status, and shutdown. A controlled delayed completion checks that healthy generation can exceed 60 seconds. Isolated native SDK tests qualify automatic timer-to-native-compaction persistence with a built extension, a deterministic custom transport without a payload hook, and a user estimate, including retained history, usage, and no self-rearming. They also qualify cancellation, no fallback, built loading, same-stack and delayed-hook reservation gates, recovery after consumed input/authentication failure, and unguarded native races. A controlled-terminal InteractiveMode test qualifies actual compaction submission queuing without entering the input gate until native dispatch; normal idle-input serialization is supported by inspection of the native main loop, not a separate full-loop test. These local fixtures use deterministic inference, not hosted-provider compatibility or semantic-fidelity certification.
