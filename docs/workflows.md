# Durable workflow proof

`src/workflow/host.ts` is an opt-in, headless integration boundary. No Pi tool, command, RPC listener, or deployment starts it. Existing review and subagent behavior is unchanged.

## Run the proof

```bash
PI_ENV_WORKFLOW_EVIDENCE=/tmp/workflow-result.json \
  nub run test:integration src/workflow/__tests__/host.integration.test.ts
```

The test bundles the worker and its dependencies into one executable. It uses real child processes, SQLite, and the durable scheduler. Only the model provider is synthetic. CI prints the retained JSON record in the verification job. `PI_ENV_WORKFLOW_EVIDENCE` also retains a JSON record locally.

The scenarios check request races, conflict and busy rejection, required and settled dependencies, bounded output, exclusive ownership, incompatible executable rejection, and recovery after `SIGKILL`. They do not qualify hosted providers, remote-effect confinement, or review migration.

## Embedding boundary

`openWorkflowHost` requires an explicit state directory, executable SHA-256, provider, and exact model reference. The host captures the provider methods and model descriptor before asynchronous startup. It owns a static model collection that caller refreshes or replacements cannot change. Definitions are registered at open. The built-in `three-stage@1` definition performs triage, confirmation, and presentation. See `src/workflow/definition.ts` for definition parsing and resource bounds.

The host admits one run at a time. Busy requests are rejected, not queued. A successful admission atomically records the principal-scoped request identity, fingerprint, run conversation, task identities, and capacity reservation. Identical retries return the original reference. Reusing an accepted identity with changed content fails.

**The embedding caller must authenticate the principal.** A request field is not proof of identity. The host applies principal checks to reads and waits, but it is not a network authentication or multi-user isolation boundary. Do not expose it directly to untrusted clients.

Each run has an ownerless conversation. Its segment owns the bounded application tasks. Agent nodes use durable conversations with no installed tools, hooks, or execution environment. Nodes receive only the workflow input and direct dependency outcomes. Text artifacts stay in the durable store. This slice does not publish filesystem artifacts.

A durable completion task joins the segment, including its owned work, then commits the immutable result entry and releases capacity. Result status distinguishes success, degraded coverage, and failure. Run history and accepted request identities have no deletion path in this slice. Closing the host preserves unfinished work for reopen.

## Storage and recovery

Use a private state directory on a supported Linux local filesystem. The host rejects unknown filesystem types, network storage, and linked database files. It keys the kernel-owned process lock by directory device and inode, not pathname. All owners must use the same Linux network namespace. Cross-container ownership is not qualified. The lock remains held until Harness shutdown completes.

Do not use a network-mounted home directory for state. A temporary directory is suitable for this proof, not for deployed persistent state. Do not move or replace an active state directory. A caller must await `close()` during orderly shutdown.

The store accepts only the original executable, registered definitions, and resolved model descriptor. Compatibility is checked before scheduling resumes. There is no hot reload or implicit migration.

SQLite WAL uses the package's normal synchronization policy. Committed state survives service-process crashes and restarts. This proof makes no power-loss or host-loss guarantee. It does not establish exactly-once external effects.
