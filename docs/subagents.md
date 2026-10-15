# Subagents

The subagent extension runs child agents in the parent Pi process. Each child has an isolated context and a linked persistent session transcript.

By default, the extension stores each child of a persistent parent below `_children/<parent-session-id>/` in the parent's session directory. A child of an in-memory parent uses Pi's native default session directory. Native Pi session discovery does not recurse into the nested child directory. This keeps the native resume picker focused on parent sessions. Recursive pi-env introspection can still list and read child transcripts. Use `pi --session <path>` to resume a child by its exact path only after its current owner has settled and released the session. Do not open the same child transcript in another Pi process while the child is running.

## Actions

The `subagent` tool uses one `action` parameter for blocking runs and background job management.

Use `action: "run"` when the parent must wait for the child result.

Use `action: "start"` to start a session-scoped job and continue parent work. The tool returns a volatile job ID. Use these actions to manage the job:

- `list` returns bounded metadata for retained jobs.
- `status` returns metadata for one job.
- `wait` waits for a terminal state. A successfully completed job returns its bounded retained final answer directly. Other terminal states return status metadata.
- `result` returns only the bounded retained final answer for a completed job. Job, usage, session, and truncation metadata remain available in tool details and the TUI.
- `cancel` requests cancellation.
- `usage` returns aggregate subagent usage for the parent session.

Use the child session file when you need the complete transcript. Live job handles do not survive a restart. The extension does not retry interrupted work automatically.

Collapsed TUI views omit the full delegated task and child output. Expanded views show the task and available child output. Tool call summaries never show an inline system prompt. Each active background child has one brief line in the lower status area immediately above the built-in footer. The line disappears when the child reaches a terminal state.

## Interactive browser

Run `/subagents` in terminal mode to inspect retained background jobs. Type to search by name, job ID, state, or model. Each row includes a short job ID to distinguish repeated names. Select a job with the arrow keys and press Enter to inspect it. The detail view shows the full job ID. Completed and failed jobs remain available until the existing retention policy evicts them.

The read-only viewer refreshes finalized child messages once per second. Use the arrow keys or Page Up and Page Down to scroll. Home moves to the beginning of the displayed content. End follows new messages. Escape returns to the job list. Escape from the list returns to the unchanged parent draft.

Opening the browser does not wait for jobs, cancel jobs, or replace the parent session. Other jobs continue under the existing supervisor. Session shutdown closes the browser.

Transcript inspection reads at most the latest 128 KiB and displays at most 32,768 text characters, plus an omission notice. The viewer reports omitted history and removes terminal control sequences. It does not rewrite child files. A transcript can be unavailable before the first finalized assistant message. Retained job diagnostics remain visible independently of transcript availability, with a separate 1,024-character limit and truncation notice. Finalized assistant errors and aborts remain visible even when their text content is empty. The viewer does not display partial streaming responses, thinking, or images.

The initial browser lists only background jobs retained in the current parent runtime. Blocking `run` calls and historical jobs after a restart are not included. Steering, continuation, nested navigation, and orchestrator mode are not implemented.

## Agent definitions and trust

The default `agent_scope` is `user`. This scope includes user agents and agents from packages registered in global settings. Packages declared in project settings do not enter the default scope.

Set `agent_scope` to `project` to use project agents or agents from project-declared packages. The target directory must be trusted before the extension resolves the agent. The current session's trust decision applies only to its own canonical directory. For a different target directory, the extension requires a saved trust grant from Pi's native `ProjectTrustStore`. A saved denial or an unknown decision rejects the request. This baseline does not prompt for new trust grants.

Model selection uses Pi's configured registry. The subagent tool advertises every available model, regardless of the native `enabledModels` cycling selection. Model annotations are descriptive guidance. They do not approve, restrict, or reserve models for particular roles.

## Execution boundaries

Built-in and shared cross-host tools use the resolved child working directory. A parent context does not override that directory. Child model requests use the configured model registry's streaming method. The initial system prompt is retained in the child transcript.

The current child runtime still uses the low-level agent loop, not a complete Pi SDK session. It does not automatically load context resources, extension hooks, native codemode, tool search, or MCP. Parent tool permission hooks do not govern direct child calls. Native-session adoption is a separate migration.

### Named agents are not native package resources

Pi loads extensions, skills, prompt templates, and themes as package resources. Named agent definitions (`agents/*.md`) are an extension convention, also used by [Pi's subagent example](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/examples/extensions/subagent/agents.ts). They are not the `AGENTS.md` context files returned by native `ResourceLoader.getAgentsFiles()`.

`loadAgentsFromPackages` remains a pi-env adapter for packaged named agents. It uses native `DefaultPackageManager.listConfiguredPackages()` for package inventory and installed roots, then reads `<package>/.pi/agents/*.md` in the selected scope. Relative project package paths resolve from the target directory's `.pi` directory. Relative global package paths resolve from Pi's agent directory. Discovery does not install or update packages.

This is not native enabled-resource discovery. Pi's package manifest, resource filters, `autoload`, and `pi config` do not define selection rules for named agents. This adapter scans configured, installed packages in the selected scope regardless of native resource selections. Discovery makes named agents available for explicit selection. It does not append their instructions to a session automatically. Temporary `pi -e` sources are not included. Agent files accept comma-separated strings or YAML arrays for tool lists, following the upstream example. pi-env also accepts either form for capability lists.

## Native-session migration contract (not implemented)

The current baseline fixes execution boundaries without replacing the child runtime. The following decisions govern the separate native-session migration. They do not describe capabilities shipped by this baseline.

- Use Pi's public SDK services and native session runtime for each child. Let Pi own model execution, messages, persistence, retries, compaction, resource loading, and extension lifecycle. Use `DefaultResourceLoader` with explicit child-safe configuration rather than reproducing native resource discovery or indiscriminately reloading every parent extension.
- Supply native settings with the target directory's resolved trust state. The SDK's default settings assume project trust. Do not mistake that default for the CLI's trust handshake or transfer trust from another working directory. Native context loading already includes target `AGENTS.md` files. Do not append them a second time. Context-file discovery is distinct from executable-package trust.
- Keep one pi-env root coordinator for admission, workspace writer leases, lineage, jobs, and aggregate usage. Native sessions do not replace those scheduling contracts. All execution paths, including review DAG and skill evaluation, must use the same child executor.
- Include the native tool migration needed to remove duplicate execution ownership. Retire the separate AgentTool publication channel and raw child loop when their consumers migrate. Do not keep two permanent execution backends. Optional output-contract improvements and recursion remain separate work.
- Preserve configured providers, credentials, and virtual models through public APIs. Prove the runtime handoff before cutover. Do not introduce model-access permissions or substitute physical models for virtual models.
- Verify the complete callable tool surface, including direct, deferred, codemode, MCP, and late registrations. Active-tool visibility alone does not enforce that boundary. Preserve tool-free evaluation and run-local review tools.
- Await active-operation settlement and native shutdown hooks during cleanup. A timeout or session disposal does not prove that external side effects stopped. Do not release a writer lease while conflicting effects can continue.

### Direct user access to children

Direct interaction is a migration requirement, not an extension of the current read-only browser:

- Inspect each child's actual delegated task, resolved instructions, model, working directory, and tools. Distinguish coordinator-authored instructions from user-authored text.
- Preserve user-authored briefs and interventions verbatim. Keep coordinator additions separate. Allow optional review or editing before delegation, without requiring approval for every child.
- Send user input directly to the selected child's native session without coordinator rewriting or approval. Use native prompting, steering, and follow-up behavior. Distinguish queued steering from immediate cancellation. Native prompt expansion and extension input hooks still apply. Retain the original input and expose effective transformations rather than claiming that native input processing is bypassed.
- Navigate between parent, children, and descendants without replacing or shutting down the parent runtime. Include synchronous children and persisted history, not only retained background jobs.
- Keep one execution owner per child. Live interaction uses that owner's session. Standalone continuation by exact path requires the prior owner to settle and release the session file first.

Acceptance evidence must cover direct input without coordinator rewriting, prompt provenance, intact parent state, single-owner live interaction, and continuation from native persisted history. These controls preserve authorship and visibility. They do not guarantee model compliance with every instruction.

### Native references

The migration targets the repository's pinned Pi 1.2.0 APIs at upstream commit `06a466935536f8c9bcacb2d5efc0fc021be1bdff`:

- [Package resources and filters](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/docs/packages.md)
- [Package inventory and resolution](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/package-manager.ts)
- [SDK ownership, resource loading, input, and completion](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/docs/sdk.md)
- [Services-based session creation](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/agent-session-services.ts)
- [Native session-runtime example](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/examples/sdk/13-session-runtime.ts)

## Resource limits

One supervisor controls admission for blocking jobs, asynchronous jobs, and direct child-runtime callers. The supervisor controls concurrency, pending runs, workspace writers, and run time.

Public `run` and `start` actions do not have a turn-count limit. The configured run-time limit still applies.

Configure limits in the `subagent` settings block:

```json
{
  "subagent": {
    "maxConcurrentRuns": 4,
    "maxPendingRuns": 16,
    "maxRetainedJobs": 32,
    "maxResultBytes": 51200,
    "maxRunMs": 1800000,
    "cancellationGraceMs": 500,
    "sessionStorage": "nested"
  }
}
```

The supervisor bounds pending admission. Write-capable runs serialize by canonical Git workspace. Retention eviction removes the volatile job handle but does not delete its child session transcript.

Set `sessionStorage` to `"sibling"` only when native Pi must discover child transcripts beside their parent. The default is `"nested"`.

## Cancellation states

A running job changes to `cancelling` after a cancellation request. A cooperative child changes to `cancelled` after it settles. If the child does not settle before the cancellation deadline, the job changes to `interrupted`.

Parent session shutdown rejects new jobs, cancels queued jobs, and drains running jobs within the configured cancellation boundary. Before parent tree navigation, the extension settles active jobs so a late result cannot attach to the selected branch.
