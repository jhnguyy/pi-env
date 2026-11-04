# Subagents

The `subagent` tool and `/subagents` browser are clients of one detached, host-owned native service. Durable owns admission, request fingerprints, dispatch and cancellation intent, and immutable operation outcomes. Pi owns target resource loading, execution, input hooks, compaction, and the native transcript. Chord carries typed control and bounded observations. The parent never executes a child locally as a fallback.

## Configure local state before use

Set `PI_ENV_SUBAGENT_STATE_DIR` in the environment launching Pi to an **explicit persistent local directory** chosen by the operator. No default host path is provisioned. The directory must be owned by the current OS user, non-symlink, mode `0700`; `<directory>/service.sock` must fit in 103 bytes. The socket uses mode `0600`. SQLite/WAL requires a supported local filesystem; network filesystems such as NFS are rejected. Keep the state directory, database, identity file, native sessions, and log private. Do not place state in a cleanup-managed temporary directory.

Build with `nub run build` before use. The [subagent sidecar](../.pi/extensions/subagent/service-main.ts) builds to `.pi/extensions/subagent/dist/service.js`. The first connection starts it if absent. Concurrent clients converge on one owner, excluded by OS user and canonical Pi agent directory, even if another client chooses a different state path. Startup and connection waits are bounded. A running service or persisted state from another executable bundle fails closed; changing the configured state path cannot bypass the live host lock.

There is no automatic store migration, archival, deletion, or version takeover. Drain and stop the existing service before an operator plans a bundle/state transition. Preserve old state for outcome reconciliation; this extension provides no retention reset or migration command. Inspect `service.log` for startup failures. Do not infer successful cancellation or absence of effects from a disconnected client or dead service.

This is **same-OS-user authority**, not a security sandbox. `parentSessionId` selects an explicit namespace, not an ACL. Trusted extensions run with the user's permissions. Workspace leases coordinate service-owned native operations, not arbitrary root bash commands or external writers. Power-loss and host-loss durability guarantees are outside this contract.

## Delegate and retrieve

Supply `name` and `task` for `run` or `start`:

- `run` waits for the immutable initial outcome and returns a bounded preview, job ID, and child ID. Its explicit abort requests service cancellation and waits for known native settlement.
- `start` returns durable job and child IDs after admission. Interrupting the launching turn, disconnecting, closing the browser, or shutting down the parent does **not** cancel accepted work.
- `list` and `status` return bounded metadata, not answers or transcripts.
- `wait` waits for an operation; aborting this waiter does not cancel that operation.
- `result` retrieves a stored operation answer. `wait` and `result` accept `offset` and `limit` (default 4096, maximum 16384).
- `cancel` records cancellation intent for the specified operation. Acknowledgement is not settlement. Cancelling a terminal initial operation cannot stop a later prompt.
- `input` takes `child_id`, `text`, and `mode` (`prompt`, `steer`, or `followUp`). It returns a separate operation ID and bounded prompt answer. Coordinator input still passes through native hooks.
- `inspect` takes `child_id`, an optional `view`, and the same paging options. Selection and pagination happen in the service, before transport.
- `reopen` explicitly initializes a historical service child without replaying its original prompt or any later input.
- `usage` reports aggregate native child usage, including later prompts. Initial result usage remains immutable.

Offsets and totals count **UTF-16 code units**, not bytes or Unicode code points. A page can split a surrogate pair; concatenate pages in offset order to reconstruct the exact answer. Complete answers remain stored. Conversation inspection shows a bounded recent native context window (32768 code units), possibly compacted; the Pi session retains finalized history. Neither native messages nor arbitrary tool-result details travel in roster or inspection responses.

Admission is idempotent only for the **same request ID and immutable payload**. Model tool-call identity supplies the request ID. Conflicting reuse rejects. Browser input retains its request identity and draft after a lost acknowledgement so retrying the same draft reacquires the same operation, not another effect. Reconnection reacquires views; it does not replay submissions. If admission is unknown, reconcile the roster or retry the same logical identity; do not create a new submission to guess whether the old one ran.

Stored outcome/deduplication authority is never evicted to make room. Admission stops at the service's bounded retained-operation capacity (default 256, hard maximum 512); live-owner retention is separate. There is no unbounded roster or full-result wire endpoint.

## Native defaults and trust

Omit `model` and `tools` for child-native defaults. Explicit model and exact tool names must be available in the target configuration; `tools: []` selects none. Glob selectors fail before resources load. Availability checks run at native preflight after Pi's bounded direct-MCP readiness wait. Unavailable tools stop inference, but startup or input hooks may already have caused effects. Handled input can check only the catalog already registered; it does not force inference to discover tools.

`system_prompt` appends delegated instructions to native context; it does not replace target `AGENTS.md`, skills, extensions, or settings. The parent model roster is selection guidance, not an allowlist. Only saved target trust is used by the service, including for the parent's own cwd. Transient root grants, providers, callbacks, CLI overrides, and credentials are not serialized into requests. Native Pi resolves its own saved configuration and authentication.

Executable run-private callbacks cannot cross the process boundary and reject before admission. Load tools through the target's native resources instead. Named-agent files and the obsolete `agent` and `agent_scope` parameters are unsupported.

Manual roots retain direct execution and coordination. The root `subagent` tool is available directly and through native codemode. Service-created and explicitly reopened children remain children across coordinator and human input: neither direct calls nor codemode can spawn another child. This does not classify or import arbitrary unmarked historical sessions.

## Browser interaction

Run `/subagents` in terminal mode, search the roster, and select a child:

- **Tab** cycles conversation, instructions, configuration, and original input provenance.
- **[ / ]** select the previous/next server-side page.
- **p / s / f** open the native multiline editor for idle prompt / running steer / running follow-up.
- **c** requests current-operation cancellation; **r** explicitly reopens historical children.
- Arrow/Page keys scroll within the page; **Home / End** navigate its rendered content.
- **Escape** returns to the roster, then the parent.

The browser hides its overlay while the native editor owns focus, preserving the parent's draft. Cancelling the editor sends nothing. Rejected/unknown input retains its draft; opening the same mode and submitting the same text reuses its pending identity. Human text is not rewritten or approved by the coordinator. Native hooks can handle or transform it. Queued steering/follow-up acknowledges native handling or queuing, **not model consumption**. Input source never promotes a child to root authority.

## Ownership, cancellation, and restart

One host supervisor coordinates all parent namespaces. Its limits come from the agent's `subagent` settings (`maxConcurrentRuns`, `maxPendingRuns`, `maxRetainedJobs`, `maxRunMs`). Target settings can narrow per-parent admission but cannot raise the host ceiling. All native operations use conservative canonical-workspace **write** leases, including startup and historical reopen. Queue waits do not hold execution permits. Known input hooks and native execution must settle before release; noncooperative cancellation retains ownership. There is no timed force release or hard-kill guarantee. A deadline requests abort, not proof that remote effects stopped.

A durable dispatch marker precedes every startup/input/model/tool effect. Accepted-undispatched initial work may dispatch after restart. Dispatched work whose outcome is uncertain becomes `interrupted` with `unknown` disposition and is never blindly replayed. Durable task faults, blocked/outdated definitions, restart-limit reports, and storage failures disconnect observers rather than strand callers behind apparently live operations. This is **not transparent native checkpoint recovery**.

Historical reopen creates one retained owner from Pi's session file without replay. Pi remains the only transcript writer. Never use `pi --session` or another manual transcript writer while the service owns that child—even if idle, completed, or cancellation-requested. Parent shutdown only disconnects its client, so it does not release native ownership. Service shutdown waits for known work and hooks before closing owners. Retention eviction closes an idle owner without deleting its transcript or outcomes.

Pi's native codemode worker budget is process-local: the service's child scripts share its slots, independently of root scripts in another process. `maxConcurrentRuns` does not raise that budget. See Pi's codemode configuration for worker limits and script timeouts.
