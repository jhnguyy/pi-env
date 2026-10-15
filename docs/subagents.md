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

Supply `name` and `task` for `run` or `start`. Omit `model` and `tools` to use child-native defaults. Explicit model and tool names must be available in the child's configuration. An explicit empty tool list selects no tools. Old AgentTool aliases, such as `dev-tools-edit`, are not native tool names. Capability-only agent definitions must select native tools explicitly; the extension rejects them rather than silently broadening their tool selection.

The model roster in the tool description describes the parent configuration for selection guidance. A child does not copy the parent's runtime-only providers, transient CLI configuration, or model catalog. Model annotations are descriptive, not delegation permissions.

`system_prompt` replaces the named agent's additional instructions, not Pi's native system/context loading. The child appends those delegated instructions to its native prompt. Native context files, skills, input hooks, and configured extensions still apply.

A completed initial result stays unchanged when a human continues the child. Use the native session for later messages. Job handles and live owners do not survive a parent restart.

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

## Agent definitions and trust

Named agents are a thin extension-owned configuration bridge, distinct from native `AGENTS.md` context. See [discovery](../.pi/extensions/subagent/agents.ts) for fields and precedence, and [resolution](../.pi/extensions/subagent/resolver.ts) for selection and trust.

The default `agent_scope: "user"` includes user agents and installed packages declared in global settings. Project agents and project-declared packages require explicit `agent_scope: "project"` and target trust. Parent trust applies only to the same canonical cwd. A different target requires a saved grant in Pi's native `ProjectTrustStore`; a denial or unknown decision rejects project-agent selection. Child startup does not prompt for new trust grants.

Named-agent candidates do not follow native package resource filters or `pi config`. Discovery lists configured installed roots without installing packages and excludes temporary `pi -e` sources. Native resource loading separately governs executable extensions and native resources.

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

Cancellation aborts native execution and waits for known tools and input hooks to settle. A running job remains `cancelling` until settlement. There is no grace-period force release or hard-kill guarantee. A run-time deadline requests abort; it does not prove that a remote effect stopped. Parent shutdown rejects new work and waits for owned work before releasing coordination.

Native children do not initialize the root subagent, review, or session-manager interfaces. Advisory skill evaluation also remains a parent operation. Review tools are supplied directly to their own native nodes, not published process-wide. Explicit review cleanup closes those retained nodes before deleting their private resources.
