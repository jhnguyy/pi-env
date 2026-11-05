# Context recap

Context recap customizes native compaction summaries in root TUI sessions and enables provider-aware idle scheduling by default. **Automatic recap makes an additional, potentially paid inference request even if you never resume the session.** It does not guarantee cache hits, lower costs, or semantic completeness.

Child sessions, RPC, print, and JSON modes keep native behavior. Build changes, then reload or restart Pi; see [extension conventions](conventions/extensions.md).

## Operating controls

Use `/context-recap` to inspect automatic scheduling state, the scheduled lifetime and its source, or the last outcome or suppression reason. It is read-only and accepts no arguments. Use native `/compact [instructions]` for manual compaction and native Esc to cancel acquired compaction. Disabling automatic recap does not disable summary customization.

To disable automatic scheduling persistently, put this in global `settings.json` or `<cwd>/.pi/settings.json`:

```json
{
  "contextRecap": { "enabled": false }
}
```

For an unknown provider, explicitly enable it and supply a scheduling estimate:

```json
{
  "contextRecap": {
    "providers": {
      "my-provider": { "enabled": true, "estimatedLifetime": "10m" }
    }
  }
}
```

Provider IDs are exact and case-sensitive. Set a provider's `enabled` to `false` to disable only that provider. Settings use the [shared settings boundary](conventions/extensions.md#settings-boundary): a project `providers` map replaces the entire global map rather than merging its entries. Invalid settings suppress automatic scheduling. Global native idle cache warming also suppresses it; Pi owns warming.

## Scheduling expectations

Supported provider, transport, and endpoint combinations are defined by [the policy defaults](../.pi/extensions/context-recap/config.ts). Unknown combinations default off. OpenAI and Codex use a built-in five-minute **estimate**, not a verified TTL or retention guarantee. Anthropic requires actual request cache breakpoints. Configured estimates replace built-in estimates; recognized actual request lifetimes take precedence. Actual caching-off or an ineligible outgoing model suppresses scheduling regardless of estimates. [Request lifetime interpretation](../.pi/extensions/context-recap/lifetime.ts) owns the metadata rules.

Only a fresh successful response from the selected physical model can schedule an idle recap. Restored history and status checks do not arm one. Activity or changed settings can consume the target; missed windows do not retry or self-rearm. A successful response and a timer anchor do not prove that caching occurred, and the recap's serialized prompt may not reuse the conversation's cached prefix.

Pi owns retained-history selection, queues, and persistence. Once native TUI compaction acquires the session, Pi queues terminal input. Safety before acquisition assumes ordinary TUI submissions are serialized; arbitrary concurrent SDK operations and earlier-loaded blocking handlers are outside that guarantee. Local cancellation cannot retract a proposal already handed to later native handlers; native Esc remains authoritative through commit.

## Fidelity and limits

Recaps preserve four sections: Objective, Plan and Progress, Remaining Work, and Information Sources. Instructions prioritize goals, approvals, decisions, evidence versus assumptions, blockers, and next actions. Inspect consequential recaps: valid headings cannot establish semantic fidelity.

The request includes all native prepared sources, prior summary, operator instructions, and full edited retained-history orientation. The extension adds no arbitrary content-length cap. Native serialization omits thinking and truncates individual tool results. Input admission and output capacity depend on the selected model's limits and native token estimates, which are not tokenizer guarantees.

Generation makes one selected-model attempt without fallback or retry. Invalid capacity cancels before inference; malformed or failed output leaves no recap. Cancellation stops waiting even if a provider ignores abort, and late output is not saved, but the request may still bill. Custom transports have no blanket generation-timeout guarantee.
