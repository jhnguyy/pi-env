# Context recap

The `context-recap` extension customizes native compaction summaries in root TUI sessions and schedules idle recaps for supported providers by default. Child sessions, RPC, print, and JSON modes keep native behavior. Pi owns compaction thresholds, retained-history selection, queues, persistence, and cache warming. After building, reload or restart Pi; see [extension conventions](conventions/extensions.md).

## Commands and settings

| Command                        | Effect                                                                                                                                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/context-recap status`        | Show scheduling state, target, lifetime and source, suppression reason, or native reservation phase.                                                                                                                        |
| `/context-recap on [duration]` | Temporarily enable scheduling for future fresh successful runs. Optional `s`, `m`, or `h` duration longer than 30 seconds supplies a current-model estimate, not a cache guarantee. Model selection discards that duration. |
| `/context-recap off`           | Temporarily disable scheduling and cancel local recap work; summary customization remains active.                                                                                                                           |
| `/context-recap now`           | Request native compaction when idle with no queued input or blocking UI; independent of automatic settings and warming.                                                                                                     |
| `/context-recap cancel`        | Consume the candidate and signal local cancellation without disabling future scheduling or aborting ordinary work.                                                                                                          |

Commands never persist settings. Optional configuration belongs in global `settings.json` or `<cwd>/.pi/settings.json`:

```json
{
  "contextRecap": {
    "enabled": true,
    "providers": {
      "openai-codex": { "enabled": true, "estimatedLifetime": "5m" },
      "my-provider": { "enabled": true, "estimatedLifetime": "10m" }
    }
  }
}
```

`enabled: false` is a master automatic-off switch, including runtime `on`; manual `now` and native compaction customization still work. Provider keys are exact, case-sensitive IDs, not model patterns. Project block fields shallowly override global fields: a project `providers` map replaces the entire global map, then built-in defaults apply. An explicitly enabled provider can use a custom endpoint. Enablement alone cannot schedule an unknown lifetime.

| Default-enabled provider / transport / endpoint                                   | Lifetime source                                                                                                                          |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic` / `anthropic-messages` / `https://api.anthropic.com`                  | Actual request cache breakpoints only: 5m or 1h, shortest applicable breakpoint. No breakpoint means caching off.                        |
| `openai` / `openai-responses` or `openai-completions` / `https://api.openai.com`  | Recognized modern request metadata; otherwise a built-in **5m scheduling estimate**.                                                     |
| `openai-codex` / `openai-codex-responses` / `https://chatgpt.com/backend-api/...` | Explicit recognized metadata when present; otherwise a built-in **5m scheduling estimate**, not a verified expiry or conservative bound. |

Other providers, transports and endpoints default off. Configured estimates override built-in estimates; current-model runtime estimates override configured estimates. Recognized actual TTLs override every estimate, while actual caching-off or a different outgoing model always suppresses scheduling. Modern public OpenAI Responses metadata uses `30m` by default and supports `12h` when `supportsExplicitPromptCacheMode` is set; explicit mode without a breakpoint is off. Legacy `24h` retention is not an expiry deadline. Codex's ordinary omitted TTL is not a backend retention guarantee. No inferred model-version catalog is maintained. See [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Codex authentication](https://developers.openai.com/codex/auth/), and [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Only provider-envelope cache metadata participates, never nested user JSON, tool arguments or schemas. Payloads and credentials are not retained or logged; later extensions can still change the outgoing payload. Settings refresh at startup, model selection, arming and launch, using one shared snapshot per refresh. Changed policy or lifetime consumes the old target rather than reusing it. Invalid settings suppress automatic recap with allowlisted repair guidance. Global native `cacheWarming: "idle"` suppresses automatic recap; project warming settings do not own this mode. The extension adds no warmer, probes, retention writes or warming-decision override.

## Scheduling and ownership

One unreferenced timer follows a fresh successful final assistant response with no tools, error or abort and a matching physical model. Restored history, enabling, and native idle never arm it. Request metadata refines the early `turn_start` anchor; transports without that hook use the early anchor with an available estimate. Neither an anchor nor a successful response proves caching occurred. The target is request time plus lifetime minus a lead of `max(30 seconds, 10% of lifetime)`; launch must occur within half that lead after the target. Late settlement, late wakeups and backwards clocks skip without retry or self-rearming.

Input, new runs, model/thinking changes, user bash, blocking UI, session/tree changes, compaction and shutdown invalidate candidates. Launch rechecks identity, idle state and queued messages. The latest unresolved input preflight blocks automatic and manual acquisition until run start; consumed input or failed authentication recovers on a later clean run. Input during a run suppresses that settlement.

The scheduler reserves ownership and calls public `ctx.compact()` on the same JavaScript stack. Input and `before_agent_start` gates invalidate and cancel synchronously before awaiting native terminal callbacks, then continue input unchanged. Early cancellation survives delayed compaction-hook entry and makes zero recap requests. Reservation ownership lasts through later native handlers and commit; only its terminal callback or shutdown releases it. Once native TUI compaction is acquired, InteractiveMode owns ordinary input queuing. The extension never intercepts raw keys, copies/replays input or broadly aborts agent work.

This scope relies on the ordinary TUI main loop serializing idle submissions. Earlier-loaded blocking handlers and arbitrary concurrent SDK operations are outside that guarantee. Native `/compact` attempts do not carry this extension's reservation. A proposal already returned to later native handlers cannot be retracted by local cancellation; native Esc/compaction abort remains authoritative through commit.

## Fidelity, limits and cost

Recaps require four nonempty sections: `Objective`, `Plan and Progress`, `Remaining Work`, and `Information Sources`. Instructions preserve goals, approvals, decisions, verification versus assumptions, blockers and next actions, but cannot guarantee semantic completeness. Inspect consequential recaps.

The request includes all prepared history, split-span prefix, prior summary, operator instructions and full edited projected retained-tail orientation. There are no extension word, character, entry-count or fixed output caps. Native serialization omits thinking and truncates individual tool results to 2,000 characters. Native token estimation admits the composed input with a 512-token framing reserve; output uses the smaller of model output capacity and remaining context capacity. Estimation is not a provider-tokenizer guarantee.

One selected-model attempt requests `cacheRetention: "none"` where supported. Invalid limits or exhausted capacity cancel before inference; malformed, incomplete or failed output cancels without native fallback, retry or another extension request. Combined native/lifecycle signals stop waiting even when a provider ignores abort; late output is not saved, but may still bill. There is no total-generation deadline. Native transports own stall limits; arbitrary custom transports do not inherit a blanket timeout guarantee. Native retained boundaries, token counts, checkpoints and usage persist unchanged.

Automatic recap adds inference work and may cost more if the session never resumes. Its serialized prompt does not guarantee reuse of the conversation's cached prefix, a cache hit, fidelity or savings. Nominal API prices and subscription usage limits differ. Pi's native warmer already owns its economic decision; this extension does not duplicate it. Disable automatic scheduling or use manual recap when those tradeoffs do not fit.

Local qualification uses deterministic inference with isolated settings and real native sessions, including built timer-to-compaction persistence and InteractiveMode input queuing. It does not certify hosted-provider behavior, retention, billing or semantic fidelity.
