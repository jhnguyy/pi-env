import { rm } from "node:fs/promises";
import { stop } from "esbuild";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { Receipt } from "../contract.js";
import { bundles, ProcessFixture } from "./process.fixture.js";

let output: string;
let fixture: ProcessFixture | undefined;
beforeAll(async () => { output = await bundles(); });
afterEach(async (context) => { await fixture?.cleanup(context.task.result); fixture = undefined; });
afterAll(async () => {
  await stop();
  if (output) await rm(output, { recursive: true, force: true });
});
async function allocate(name: string): Promise<ProcessFixture> {
  fixture = new ProcessFixture(output, name);
  await fixture.start();
  return fixture;
}

it("shares one native owner across clients, survives submitter death, and preserves initial result and steering provenance", async () => {
  const f = await allocate("shared-owner");
  await f.service();
  const [a, b] = await Promise.all([f.client(), f.client()]);
  const input = f.submit();
  const [receipt, duplicate] = await Promise.all([
    a.call<Receipt>({ action: "submit", input }), b.call<Receipt>({ action: "submit", input }),
  ]);
  expect(duplicate).toEqual(receipt);
  await expect(b.call({ action: "submit", input: { ...input, task: "conflicting task" } })).rejects.toThrow(/request_conflict/);
  await expect(b.call({ action: "cancel", input: { requestId: input.requestId, operationId: receipt.operationId } })).rejects.toThrow(/request_conflict/);
  await f.entered();
  await b.operation(receipt, "dispatched");
  expect(await f.effects()).toHaveLength(1);
  const steer = await b.call<Receipt>({ action: "input", input: { requestId: "steer", childId: receipt.childId, mode: "steer", text: "original human steer" } });
  const queued = await b.operation(steer, "completed");
  expect(queued.childId).toBe(receipt.childId);
  expect(queued.result?.disposition).toBe("queued");
  const followUp = await b.call<Receipt>({ action: "input", input: { requestId: "follow-up", childId: receipt.childId, mode: "followUp", text: "original human follow-up" } });
  expect((await b.operation(followUp, "completed")).result?.disposition).toBe("queued");
  await a.kill();
  expect(b.snapshot?.operations.find((op) => op.operationId === receipt.operationId)?.status).toBe("dispatched");
  await f.release();
  const initial = await b.operation(receipt, "completed");
  expect(initial.result).toMatchObject({ text: "follow-up answer", truncated: false });
  const later = await b.call<Receipt>({ action: "input", input: { requestId: "later", childId: receipt.childId, mode: "prompt", text: "human later" } });
  expect((await b.operation(later, "completed")).result?.text).toBe("later answer");
  const failed = await b.call<Receipt>({ action: "input", input: { requestId: "human-failure", childId: receipt.childId, mode: "prompt", text: "human failure" } });
  expect((await b.operation(failed, "failed")).result?.disposition).toBe("failed");
  expect(b.snapshot?.operations.find((op) => op.operationId === receipt.operationId)).toEqual(initial);
  const inspection = await b.call<string>({ action: "inspect", input: { childId: receipt.childId } });
  expect(Buffer.byteLength(inspection)).toBeLessThanOrEqual(16_384);
  const parsed = JSON.parse(inspection);
  expect(parsed.native.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ text: "original human steer", source: "human", mode: "steer" })]));
  expect(parsed.native).toMatchObject({ task: input.task, name: input.name, cwd: input.cwd, runId: receipt.operationId });
  expect(parsed.native.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ text: "original human follow-up", source: "human", mode: "followUp" })]));
  expect(parsed.native.initialResult.finalOutput).toBe("follow-up answer");
  expect(await f.effects()).toHaveLength(1);
  f.observations.push({ receipt, initial, inspection: parsed, effects: await f.effects() });
}, 60_000);

it("marks crash-after-effect unknown and deduplicates after restart without replay, while admitting fresh work", async () => {
  const f = await allocate("crash-recovery");
  const service = await f.service();
  const a = await f.client();
  const input = f.submit();
  const receipt = await a.call<Receipt>({ action: "submit", input });
  await f.entered();
  await a.operation(receipt, "dispatched");
  const identity = a.snapshot!;
  await service.kill();
  await a.kill();
  await f.service();
  const b = await f.client();
  const interrupted = await b.operation(receipt, "interrupted");
  expect(interrupted.result).toMatchObject({ disposition: "unknown" });
  expect(b.snapshot?.serviceId).toBe(identity.serviceId);
  expect(b.snapshot?.epoch).not.toBe(identity.epoch);
  expect(await b.call<Receipt>({ action: "submit", input })).toEqual(receipt);
  const fresh = await b.call<Receipt>({ action: "submit", input: f.submit("fresh", "fresh work") });
  expect((await b.operation(fresh, "completed")).result?.text).toBe("fresh answer");
  expect(await f.effects()).toHaveLength(1);
  expect(b.snapshot?.operations.find((op) => op.operationId === receipt.operationId)).toEqual(interrupted);
  f.observations.push({ receipt, interrupted, snapshot: b.snapshot, effects: await f.effects() });
}, 60_000);

it("refuses a second service owner and a non-private state directory", async () => {
  const f = await allocate("exclusive-private");
  const service = await f.service();
  const second = f.spawn("service.js");
  await second.wait("second owner refused", () => second.exited ? true : undefined, true);
  expect(second.ready).toBe(false);
  expect(second.process.exitCode).not.toBe(0);
  const client = await f.client();
  const receipt = await client.call<Receipt>({ action: "submit", input: f.submit("healthy", "fresh work") });
  expect((await client.operation(receipt, "completed")).result?.text).toBe("fresh answer");
  const cli = f.spawn("cli.js", f.state, JSON.stringify({ action: "status" }));
  await cli.wait("status CLI exit", () => cli.exited ? true : undefined, true);
  expect(cli.process.exitCode).toBe(0);
  expect(JSON.stringify(cli.transcript)).toContain(receipt.operationId);
  expect(JSON.stringify(cli.transcript)).toContain("fresh answer");
  await client.kill();
  await service.kill();
  await f.publicState();
  const unsafe = f.spawn("service.js");
  await unsafe.wait("private directory refused", () => unsafe.exited ? true : undefined, true);
  expect(unsafe.ready).toBe(false);
  expect(unsafe.process.exitCode).not.toBe(0);
  expect(JSON.stringify(unsafe.transcript)).toContain("private_state_directory_required");
  f.observations.push({ second: second.transcript, unsafe: unsafe.transcript });
}, 60_000);

it("holds cancellation until a non-cooperative native tool settles and shuts down cleanly", async () => {
  const f = await allocate("noncooperative-cancel");
  const service = await f.service();
  const a = await f.client();
  const receipt = await a.call<Receipt>({ action: "submit", input: f.submit("noncooperative", "uncooperative initial") });
  await f.entered();
  await a.call({ action: "cancel", input: { requestId: "cancel", operationId: receipt.operationId } });
  await f.entered("aborted");
  expect(a.snapshot?.operations.find((op) => op.operationId === receipt.operationId)).toMatchObject({ status: "dispatched", cancelRequested: true });
  await expect(a.call({ action: "submit", input: f.submit("cancel", "fresh work") })).rejects.toThrow(/request_conflict/);
  await f.release();
  await a.operation(receipt, "cancelled");
  const fresh = await a.call<Receipt>({ action: "submit", input: f.submit("fresh", "fresh work") });
  expect((await a.operation(fresh, "completed")).result?.text).toBe("fresh answer");
  await a.call({ action: "cancel", input: { requestId: "stale-cancel", operationId: receipt.operationId } });
  expect(a.snapshot?.operations.find((op) => op.operationId === fresh.operationId)?.status).toBe("completed");
  await a.kill();
  service.process.send("shutdown");
  await service.wait("graceful shutdown", () => service.exited ? true : undefined, true);
  expect(service.process.exitCode).toBe(0);
  expect(await f.effects()).toHaveLength(1);
  f.observations.push({ receipt, snapshot: a.snapshot, effects: await f.effects() });
}, 60_000);

it("settles cooperative cancellation of an executing native tool without repeating its external effect", async () => {
  const f = await allocate("cooperative-cancel");
  await f.service();
  const a = await f.client();
  const receipt = await a.call<Receipt>({ action: "submit", input: f.submit() });
  await f.entered();
  const queued = await a.call<Receipt>({ action: "submit", input: f.submit("queued") });
  await a.operation(queued, "dispatched");
  await a.call({ action: "cancel", input: { requestId: "cancel-queued", operationId: queued.operationId } });
  await a.operation(queued, "cancelled");
  expect(a.snapshot?.operations.find((op) => op.operationId === receipt.operationId)?.status).toBe("dispatched");
  expect(await f.effects()).toHaveLength(1);
  await a.call({ action: "cancel", input: { requestId: "cancel", operationId: receipt.operationId } });
  const cancelled = await a.operation(receipt, "cancelled");
  expect(cancelled.cancelRequested).toBe(true);
  expect(await f.effects()).toHaveLength(1);
  expect(await a.call<Receipt>({ action: "submit", input: f.submit() })).toEqual(receipt);
  f.observations.push({ receipt, cancelled, effects: await f.effects() });
}, 60_000);
