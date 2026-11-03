import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openServiceRuntime } from "../runtime.js";
import { serve } from "../transport.js";
import { connect } from "../client.js";

const root = await mkdtemp(join(tmpdir(), "subsvc-cap-"));
const agentDir = join(root, "agent");
await mkdir(agentDir);
const state = join(root, "state");
const capability = {
  kind: "private",
  descriptor: {
    unknownAuthority: [
      { path: "/forbidden", nested: { surprise: true, values: [null, 1, "text"] } },
    ],
  },
  "line\nbreak": { key: "retained" },
};
const request = {
  requestId: "reject",
  runId: "run",
  name: "child",
  task: "task",
  cwd: root,
  capability,
};
let resolveCalls = 0;
let parseCalls = 0;
let runtime: Awaited<ReturnType<typeof openServiceRuntime>> | undefined;
let transport: Awaited<ReturnType<typeof serve>> | undefined;
let client: Awaited<ReturnType<typeof connect>> | undefined;
try {
  runtime = await openServiceRuntime({
    directory: state,
    agentDir,
    bundleId: "a".repeat(64),
    capabilityAdapter: {
      async parse(received) {
        parseCalls++;
        assert.deepEqual(received.capability, capability);
        const before = runtime!.snapshot("parent");
        // Yield across the adapter boundary: no admission may race the decision.
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(runtime!.snapshot("parent"), before);
        throw new Error("unknown_descriptor_authority");
      },
      async resolve() {
        resolveCalls++;
        throw new Error("must_not_resolve");
      },
    },
  });
  const before = runtime.snapshot("parent");
  await assert.rejects(runtime.submit("parent", request), /unknown_descriptor_authority/);
  assert.deepEqual(runtime.snapshot("parent"), before);
  transport = await serve(state, runtime);
  client = await connect(state, "parent");
  await assert.rejects(client.view.submit(request), /unknown_descriptor_authority/);
  assert.deepEqual(runtime.snapshot("parent"), before);
  assert.equal(parseCalls, 2);
  assert.equal(resolveCalls, 0);
  await client.close();
  client = undefined;
  await transport.close();
  transport = undefined;
  await runtime.close();
  runtime = undefined;
  const storage = await openNodeSqliteStorage(join(state, "service.sqlite"));
  try {
    assert.equal((await storage.scanConversations({}, 10, undefined, context)).items.length, 0);
    assert.equal((await storage.scanTasks({}, 10, undefined, context)).items.length, 0);
  } finally {
    await storage.close(context);
  }
  // A fresh reader must see no child or operation persisted by either refusal.
  runtime = await openServiceRuntime({ directory: state, agentDir, bundleId: "a".repeat(64) });
  assert.equal(runtime.snapshot("parent").operations.length, 0);
  assert.equal(runtime.snapshot("parent").children.length, 0);
  console.log("capability direct/runtime transport rejection and restart passed");
} finally {
  const outcomes = await Promise.allSettled([
    client?.close(),
    transport?.close(),
    runtime?.close(),
  ]);
  await rm(root, { recursive: true, force: true });
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (failures.length) throw new AggregateError(failures, "Capability fixture cleanup failed");
}
