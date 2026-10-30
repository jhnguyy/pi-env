# Subagents

The subagent extension delegates work to native Pi SDK sessions in the parent process. Each child loads configuration and resources for its target working directory. Pi owns its model execution, tools, messages, persistence, retry, and compaction. See the [common entrypoint](../.pi/extensions/subagent/execute.ts) and [native owner](../.pi/extensions/subagent/native-child.ts).

## Delegation and results

The `subagent` tool uses one `action` parameter:

- `run` waits for the child's initial result.
- `start` starts a background job and returns a volatile job ID.
- `list` and `status` return retained job metadata.
- `wait` waits for a terminal job state. Completed jobs return their bounded initial answer; other terminal states return metadata.
- `result` returns the bounded initial answer of a completed job.
- `cancel` requests cancellation of the job's current initial operation.
- `usage` reports aggregate child usage, including subsequent human prompts.

The parent can call `subagent` directly or through native codemode with `tools.subagent(...)`. Pi owns nested-call events, usage aggregation, and cancellation signals. Children can use their own native codemode when their settings or explicit tool selection enable it. Child scripts reach the child's native callable tools, not the parent's registry. The root `subagent` tool is not registered in children, so neither direct calls nor codemode scripts can delegate recursively. Pi also excludes codemode itself from script-callable tools.

Supply `name` and `task` for `run` or `start`. Omit `model` and `tools` to use child-native defaults. Explicit model and tool names must be available in the child's configuration. An explicit empty tool list selects no tools. Old AgentTool aliases, such as `dev-tools-edit`, are not native tool names.

Glob tool selectors fail before child resources load. Exact tool availability is checked at native model preflight, after Pi's bounded direct-MCP readiness wait. Unavailable names stop inference, but native startup and input hooks may already have caused effects. If an input hook handles the task without model preflight, only the already-registered catalog can be checked. A configured MCP tool that is not yet discovered can fail on that handled-input path.

The model roster in the tool description describes the parent configuration for selection guidance. It lists the parent's scoped models (`--models` or `enabledModels`) when a scope exists, and every available model otherwise. The roster does not restrict selection: any available model works, and an unavailable selection reports the available models. A child does not copy the parent's runtime-only providers, transient CLI configuration, or model catalog. Model annotations are descriptive, not delegation permissions.

`system_prompt` supplies additional delegated instructions, not a replacement for Pi's native system/context loading. The child appends those delegated instructions to its native prompt. Native context files, skills, input hooks, and configured extensions still apply.

A completed initial result stays unchanged when a human continues the child. Use the native session for later messages. Job handles and live owners do not survive a parent restart.

## Opt-in shared service

The shared native service is a separate, explicit entrypoint. It does not change the default `subagent` tool or `/subagents` browser. On Linux, start one foreground service with a private state directory on a local filesystem:

```bash
nub run build
mkdir -m 700 /tmp/pi-env-subagents
nub run subagent:service /tmp/pi-env-subagents
```

Use a persistent private directory instead of `/tmp` when history must survive temporary-directory cleanup. An optional second argument selects the service's native Pi agent directory. The service uses that directory's saved project-trust decisions; it never inherits a client's transient trust, providers, tools, or settings. Native children load their own target configuration as usual. This is not a sandbox.

In another terminal, send one JSON command on stdin. The command returns after admission, not after inference:

```bash
printf '%s\n' '{"action":"submit","request":{"requestId":"example-1","name":"inspect","task":"Summarize the repository instructions.","cwd":"/absolute/path/to/repository","tools":["read"]}}' \
  | nub run subagent:client /tmp/pi-env-subagents
printf '%s\n' '{"action":"status"}' \
  | nub run subagent:client /tmp/pi-env-subagents
```

The receipt contains `childId` and `operationId`. Other commands are:

- `input`: `request` contains a unique `requestId`, `childId`, `mode` (`prompt`, `steer`, or `followUp`), and `text`.
- `cancel`: `request` contains a unique `requestId` and the exact `operationId` to cancel. Acknowledgement records intent, not settlement; it cannot cancel a later operation accidentally. Already-dispatched steering/follow-up input cannot be withdrawn and rejects cancellation; its actual delivery outcome remains authoritative.
- `inspect`: supply `childId` for bounded native conversation/configuration/provenance inspection. Output may be truncated; the native transcript remains complete.

Programmatic clients use `connect()` in [`src/subagent-service/client.ts`](../src/subagent-service/client.ts). Its Chord view exposes the same control methods and a subscribed `snapshot`. Closing a client or dropping its connection does not cancel accepted work. Two clients control the same retained native owner; attaching does not create another transcript writer. Results of the initial operation remain separate from later human operations. A steering/follow-up result of `queued` is delivery acknowledgement, not model consumption.

Access is deliberately per OS user: the state directory must be owned, non-symlink mode `0700`, and the Unix socket owned mode `0600`. There is no TCP listener, multi-user ACL, automatic discovery, auto-start, or automatic reconnect. A process lock excludes a second service before it opens SQLite. Runtime changes require drain/restart; hot reload is not enabled.

The first slice caps pending/active operations at 20 and retains at most 128 admitted operations and 128 cancellation identities per store. Inputs are at most 16,384 characters and 64 KiB encoded; result previews retain 4 KiB, inspection 16 KiB. Capacity exhaustion rejects admission without deleting history. Native admission also retains its existing workspace serialization and limits; it does not coordinate independently running root Pi writers.

Service state and request deduplication persist in SQLite. Retry the same request identity after losing an acknowledgement; different content under that identity is rejected. Restart requires the same executable digest, Node version, and agent directory. A changed bundle is rejected rather than silently resuming incompatible work.

**Recovery limit:** accepted but undispatched initial work can resume. Dispatched native operations become `interrupted` with an unknown effect outcome after service loss; they never automatically rerun. Completed results remain available. Native input queues and partially executed tool batches are not recoverable in this slice, and historical native owners are not automatically reopened. A new input to an unavailable owner fails; submit new work explicitly. This provides durable control state and interruption containment, not durable native inference. SIGINT/SIGTERM stop admission and request native settlement; non-cooperative tools can delay shutdown indefinitely. Use the same state directory on restart after a forced termination.

## Direct interaction

Run `/subagents` in terminal mode. The roster includes retained blocking children, background children, and internal native children such as review nodes. Type to search; use the arrow keys and Enter to select a child.

In a child view:

- **Tab** cycles through conversation, instructions, configuration, and input provenance.
- **p** opens the native multiline editor for an idle prompt.
- **s** opens it for steering a running child.
- **f** opens it for a follow-up to a running child.
- **c** requests cancellation of the current operation.
- **Arrow keys / Page Up / Page Down** scroll. **Home** moves to the beginning; **End** follows new output.
- **Escape** returns to the roster, then to the parent.

The native editor uses the user's Pi editor bindings, including external-editor support. The browser temporarily hides its overlay while that editor owns focus. It does not replace the parent session or change the parent draft. Cancelling the editor sends nothing. A rejected submission retains its text for retry in the same child/input mode while the browser remains open.

Human text goes directly to the existing child owner. The coordinator does not rewrite or approve it. Native input hooks, commands, and expansions can still handle or transform it. Provenance records the original coordinator task and human inputs separately from the resulting native conversation. Queued steering or follow-up is not a claim that the model has already consumed it. Input mode is revalidated when submitted.

Configuration inspection separates active tools from callable tools. Instructions and provenance preserve multiline text and remove terminal controls for display. Conversation display shows finalized native context messages, with a 32,768-character display limit and an omission notice. Native compaction can summarize earlier messages. The browser does not display partial streaming responses, thinking, or images. Inspect the native session file for retained history.

Closing the browser does not cancel or close children. Parent shutdown closes the browser and its retained owners. This browser does not reopen historical sessions or provide nested delegation.

## Persistence and ownership

For a persistent parent, children normally live under `_children/<parent-session-id>/` in the parent's session directory. Native Pi discovery does not recurse into that directory. Recursive pi-env introspection can find these files. Children of in-memory parents use Pi's default session directory.

Use `pi --session <exact-path>` only **after the previous owner closes**, such as after parent shutdown or retention eviction. Completion, idleness, or a cancellation request alone does not release a retained owner. Do not attach another transcript writer to a live child. Eviction does not delete its native session file.

Set `subagent.sessionStorage` to `"sibling"` only when native Pi discovery must find children beside their parent. The default is `"nested"`.

## Native context and trust

Custom named-agent definitions are no longer supported. The extension does not scan user, project, or package `.pi/agents` directories. The public `agent` and `agent_scope` parameters and DAG payload `agent` field are rejected, not ignored. Supply explicit `model`, `tools`, and `system_prompt` overrides instead, or omit them for native target defaults.

Native `AGENTS.md` context loading is unchanged. Pi loads target configuration, context, skills, and extensions through its native resource loader. Parent trust applies only to the same canonical cwd. A different target uses its saved decision in Pi's native `ProjectTrustStore`; unknown or denied targets do not receive project trust. Child startup does not prompt for new grants. See [target trust resolution](../.pi/extensions/subagent/resolver.ts) and [native child startup](../.pi/extensions/subagent/native-child.ts).

## Limits and cancellation

One parent supervisor controls blocking runs, background jobs, internal DAG children, and idle continuations. Configure its limits in the `subagent` settings block:

```json
{
  "subagent": {
    "maxConcurrentRuns": 4,
    "maxPendingRuns": 16,
    "maxRetainedJobs": 32,
    "maxResultBytes": 51200,
    "maxRunMs": 1800000,
    "sessionStorage": "nested"
  }
}
```

All native operations conservatively acquire a workspace write lease. Native callable surfaces can exceed initial active-tool visibility, so a read-only label is not sufficient evidence for concurrent writers. Operations in the same canonical Git workspace serialize. Retention bounds settled owners and job handles; result truncation does not truncate the native transcript. Public runs have no turn-count limit. Internal callers can impose an initial-operation turn limit.

Pi defaults to two live codemode workers across all sessions in one process. Set `PI_CODEMODE_MAX_WORKERS` to a positive integer to change this limit. Parent and child scripts share those slots. A parent script waiting for children occupies one slot, leaving one for child scripts at the default limit. At capacity, new scripts wait in arrival order for up to 60 seconds. The wait counts toward the script's `timeout_ms`. Cancelled workers occupy their slots until they exit. `maxConcurrentRuns` does not raise this upstream limit.

Cancellation aborts native execution and waits for known tools and input hooks to settle. A running job remains `cancelling` until settlement. There is no grace-period force release or hard-kill guarantee. A run-time deadline requests abort; it does not prove that a remote effect stopped. Parent shutdown rejects new work and waits for owned work before releasing coordination.

Native children do not initialize the root subagent, review, or session-manager interfaces. Advisory skill evaluation also remains a parent operation. Review tools are supplied directly to their own native nodes, not published process-wide. Explicit review cleanup closes those retained nodes before deleting their private resources.
