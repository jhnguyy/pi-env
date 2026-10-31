# Subagents

The `subagent` tool and `/subagents` browser share one service-owned native execution path. The parent keeps a client connection and metadata views, not child execution or job lifecycle state. The detached service owns native Pi sessions, admission, cancellation, and durable records. See the [client lifecycle](../.pi/extensions/subagent/session-runtime.ts), [service](../src/subagent-service/runtime.ts), and [native owner](../.pi/extensions/subagent/native-child.ts).

## Delegation and inspection

Supply `name` and `task` for `run` or `start`:

- `run` waits for the initial answer.
- `start` returns a durable job ID and stable child ID after admission.
- `list` and `status` return metadata, not answers or conversations.
- `wait` waits for the initial operation and returns bounded output. Stopping the wait does not cancel execution.
- `result` retrieves an operation's stored answer using its job/operation ID. The initial answer stays immutable. `offset` and `limit` select a page: default 4,096, maximum 16,384 UTF-16 characters. Pagination does not truncate the stored answer.
- `cancel` records cancellation intent for that job's initial operation. Acknowledgement is not settlement; the job remains `cancelling` until native work settles.
- `input` sends `text` to `child_id`, using `mode: "prompt"`, `"steer"`, or `"followUp"`. Prompt requires an idle child; steer and follow-up require a streaming child. Input returns an operation ID and a bounded prompt answer; use `result` to retrieve further pages.
- `inspect` retrieves one bounded view of `child_id`: `conversation`, `instructions`, `configuration`, or `provenance`. It accepts the same pagination controls.
- `reopen` explicitly restores historical conversation context into an idle owner. It does not repeat an interrupted prompt, model request, or tool call.
- `usage` reports child usage.

The initial result never changes when someone continues the child. Later operations have separate durable outcomes. Steering/follow-up acknowledgement means native input was queued or handled, not necessarily consumed by a model.

Coordinator input uses Pi's extension provenance; browser input uses interactive human provenance. Both pass through native input hooks, commands, and expansions. Neither requires a summarizer turn. Full human browsing stays outside the parent model's context; only explicit tool retrieval returns selected text.

Omit `model` and `tools` for child-native defaults. `tools: []` selects no tools. Explicit tools must use exact native names; glob selectors fail before native startup. Exact availability is checked after Pi's bounded direct-MCP readiness wait, before inference. Startup and input hooks may already have caused effects. Handled inputs cannot force discovery through a dummy model turn.

`system_prompt` appends delegated instructions to native context; it does not replace Pi's system prompt, context files, skills, or extensions. The advertised model roster describes the parent's selection guidance, not the child's available-model authority. Children do not inherit transient parent providers or executable tool callbacks. Named agent definitions and `agent`/`agent_scope` parameters are rejected.

Children can use native codemode and MCP. Root subagent, review, and session-manager interfaces do not initialize in child context, so recursive delegation is not exposed. Tool selection is not a sandbox.

## Human interaction

Run `/subagents` in terminal mode. Search the metadata roster, then select a child. Only the selected child's inspection is loaded.

- **Tab** cycles conversation, instructions, configuration, and provenance.
- **p**, **s**, and **f** open the native multiline editor for prompt, steering, and follow-up.
- **r** explicitly reopens a historical child.
- **c** requests cancellation and waits for settlement.
- **Arrow keys / Page Up / Page Down** scroll; **Home / End** move to the start or follow new output.
- **Escape** returns to the roster, then to the parent.

The overlay hides while the native editor owns focus; it does not replace the parent's editor or draft. Cancelling the editor sends nothing. Rejected input retains its draft while the browser stays open. Conversations show finalized native context, which may contain compaction summaries; native session files retain history. Closing the browser does not cancel work.

## Ownership and durability

On Linux, the normal interface starts or attaches to the service automatically. There is no opt-in tool, alternate execution backend, or local-execution fallback. Service failure is visible to callers.

Service state lives in an owned mode-`0700` local directory under `/tmp/pi-sa-<uid>-<agent-directory-hash>/v2/`; the Unix socket is mode `0600`. SQLite requires a supported local filesystem, not NFS. A process lock excludes duplicate hosts. The service is scoped to the same OS user, native agent directory, executable bundle, and Node version. Clients require the matching executable digest; a changed bundle cannot silently start a second host for the same agent directory. Drain and stop the existing service before archiving its state and starting a changed executable. Historical stores remain tied to their original executable; no cross-version state migration is provided. Parent-session IDs namespace records; they are not multi-user ACLs. Native child session files live inside service storage and remain addressable through metadata.

Durable admission and request identities precede native effects. Repeating the same identity and content returns the same receipt; conflicting content fails. The service retains complete initial results separately from previews and native history. Capacity exhaustion rejects admission rather than deleting deduplication records. Temporary-directory cleanup and power-loss durability are outside this contract.

Parent shutdown, navigation, or client disconnection does not cancel accepted work. A new connection to the same parent namespace can inspect its durable records. Explicit cancellation and run cleanup remain service operations. Never open a second writer with `pi --session` while the service retains the owner: idle or completed does not mean ownership was released.

### Recovery boundary

Accepted but undispatched initial work can dispatch after process restart. Dispatched work becomes `interrupted`, with an unknown effect outcome; it never automatically runs again. Completed results remain readable.

Continuation of a live retained child, reopening historical conversation context, and recovery of interrupted execution are different operations. Explicit `reopen` only restores an idle native session. It cannot recover a pending native tool batch or input queue. Transparent native checkpoint recovery is not implemented.

SIGINT/SIGTERM stop service admission and request native settlement. Cancellation waits for known tools and input hooks; non-cooperative effects can delay it indefinitely. There is no timer-based force release or guarantee that a remote effect stopped.

## Native configuration and internal callers

Children load configuration for their target cwd from the service's agent directory. Saved `ProjectTrustStore` decisions control project extensions; the service does not inherit a client's transient trust grant or prompt for one. Native `AGENTS.md`, skills, input hooks, MCP, retry, compaction, and persistence remain Pi-owned.

Service admission coordinates native operations and canonical workspace leases. Configure `subagent.maxConcurrentRuns`, `maxPendingRuns`, `maxRetainedJobs`, and `maxRunMs` in native settings. The host reads global settings. Each child's target settings govern its parent-session admission and deadline, within the host's concurrency and retention bounds. Owner eviction preserves durable records and native session files. The old parent-local `sessionStorage` and `maxResultBytes` settings no longer apply: storage belongs to the service and retrieval uses explicit pagination.

A deadline requests abort, not early release. Public runs have no turn-count limit; internal DAG callers can supply an initial-operation turn limit and reasoning selection.

DAG scheduling and journaling remain in the parent, but DAG children use the same service as public delegation. Review-private tools are constructed service-side from a data-only, run-bound review capability. Executable callbacks do not cross the connection or enter graph artifacts. Explicit DAG cancellation closes its service run and waits for native settlement; parent disconnection only detaches. Closed internal runs cannot accept further input or reopen. Review cleanup must also await run-close acknowledgement before deleting its worktree or artifacts.

Pi's native codemode worker limit applies within each process. Parent and service run in different processes; increasing subagent concurrency does not change upstream worker limits.
