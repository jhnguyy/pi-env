import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { RunReference, RunState } from "../runtime.js";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, type TestContext } from "vitest";

type Reply = { id: number; value?: unknown; error?: string };
type CompletedRun = Extract<RunState, { status: "completed" }>;
type ProviderCall = { stage: string; input: string; tools: string[]; baseUrl: string };

class Worker {
  readonly child: ChildProcess;
  readonly messages: unknown[] = [];
  readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly exited: Promise<unknown>;
  #next = 0;
  #stderr = "";

  constructor(entry: string, directory: string, mode = "normal", bundleOverride = "") {
    this.child = fork(entry, [directory, mode, bundleOverride], {
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.exited = once(this.child, "exit");
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.#stderr += chunk.toString();
    });
    this.child.on("message", (message: Reply) => {
      this.messages.push(message);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.value);
    });
    this.child.on("exit", () => {
      for (const pending of this.pending.values())
        pending.reject(new Error(`Worker exited: ${this.#stderr}`));
      this.pending.clear();
    });
  }

  request(action: "submit", value: unknown): Promise<RunReference>;
  request(action: "status", value: unknown): Promise<RunState>;
  request(action: "wait" | "wait-mutated", value: unknown): Promise<CompletedRun>;
  request(action: "calls"): Promise<ProviderCall[]>;
  request(
    action: "ready" | "close" | "at-confirm" | "release" | "replace-provider",
  ): Promise<unknown>;
  request(action: string, value?: unknown): Promise<unknown> {
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ id, action, value });
    });
  }

  async kill(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    await this.exited;
  }
}

let directory: string;
let entry: string;
let revision: string;
let executionBundle: string;
const testTasks: TestContext["task"][] = [];
const workers: Worker[] = [];
const cases: unknown[] = [];
const request = {
  principal: "alice",
  requestId: "request-1",
  workflow: "three-stage",
  version: 1,
  input: { text: "Inspect the synthetic change." },
};

async function start(state: string, mode?: string, bundleOverride?: string): Promise<Worker> {
  const worker = new Worker(entry, state, mode, bundleOverride);
  workers.push(worker);
  await worker.request("ready");
  return worker;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-env-durable-workflow-"));
  entry = join(directory, "worker.mjs");
  revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await build({
    entryPoints: ["src/workflow/__tests__/worker.ts"],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  });
  executionBundle = createHash("sha256")
    .update(await readFile(entry))
    .digest("hex");
});

afterEach((context) => {
  testTasks.push(context.task);
});

afterAll(async () => {
  try {
    const results = await Promise.allSettled(workers.map((worker) => worker.kill()));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason));
  } finally {
    const testResults = testTasks.map((task) => ({ name: task.name, state: task.result?.state }));
    const report = {
      revision,
      executionBundle,
      input: request,
      reproduce: "nub run test:integration src/workflow/__tests__/host.integration.test.ts",
      classification:
        "workflow E2E; real subprocesses and SQLite; synthetic provider, no hosted-provider qualification",
      verdict:
        testResults.length > 0 && testResults.every((test) => test.state === "pass")
          ? "passed"
          : "failed",
      tests: testResults,
      cases,
    };
    try {
      console.log(JSON.stringify(report));
      const evidence = process.env.PI_ENV_WORKFLOW_EVIDENCE;
      if (evidence) {
        await mkdir(dirname(evidence), { recursive: true });
        await writeFile(evidence, JSON.stringify(report, null, 2));
      }
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("durable workflow host", () => {
  it("recovers an admitted run after SIGKILL without duplicating completed stages or requests", async () => {
    const state = join(directory, "recovery");
    const first = await start(state, "hold-confirm");
    const reference = await first.request("submit", request);
    await first.request("at-confirm");
    const before = await first.request("status", { principal: "alice", reference });
    expect(before.status).toBe("running");
    expect(before.nodes.map((node) => node.id)).toEqual(["triage", "confirm", "present"]);
    await first.kill();

    const resumed = await start(state);
    expect(await resumed.request("submit", request)).toEqual(reference);
    const completed = await resumed.request("wait", { principal: "alice", reference });
    expect(completed.status).toBe("completed");
    expect(completed.result.status).toBe("succeeded");
    expect(completed.result.output).toBe("Presentation: confirmed synthetic change.");
    expect(completed.resultEntryId).toBeGreaterThan(0);
    expect(completed.result.nodes.map((node) => node.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(completed.nodes.map((node) => node.taskId)).toEqual(
      before.nodes.map((node) => node.taskId),
    );
    const calls = await resumed.request("calls");
    expect(calls.map((call) => call.stage)).toEqual(["confirm", "present"]);
    expect(calls.every((call) => call.tools.length === 0)).toBe(true);
    expect(calls[0].input).toContain("Triage artifact");
    expect(calls[1].input).toContain("Confirmation artifact");
    expect(calls[1].input).not.toContain("Triage artifact");
    await resumed.request("close");

    const reopened = await start(state);
    expect(await reopened.request("wait", { principal: "alice", reference })).toEqual(completed);
    expect(await reopened.request("calls")).toEqual([]);
    cases.push({
      scenario: "SIGKILL during confirmation and reopen after completion",
      expected: "stable identities, no repeated triage, immutable presenter result",
      actual: completed,
      resumedCalls: calls,
    });
  });

  it("serializes identical/conflicting requests and rejects busy work without queueing it", async () => {
    const worker = await start(join(directory, "admission"), "hold-confirm");
    const [first, duplicate] = await Promise.all([
      worker.request("submit", request),
      worker.request("submit", request),
    ]);
    expect(duplicate).toEqual(first);
    await expect(
      worker.request("submit", { ...request, input: { text: "Different input" } }),
    ).rejects.toThrow("request_conflict");
    await expect(worker.request("submit", { ...request, requestId: "later" })).rejects.toThrow(
      "busy",
    );
    await expect(worker.request("submit", { ...request, principal: "bob" })).rejects.toThrow(
      "busy",
    );
    await expect(worker.request("status", { principal: "bob", reference: first })).rejects.toThrow(
      "not_found",
    );
    await worker.request("release");
    await worker.request("wait", { principal: "alice", reference: first });
    const later = await worker.request("submit", { ...request, requestId: "later" });
    expect(later).not.toEqual(first);
    await worker.request("wait", { principal: "alice", reference: later });
    cases.push({
      scenario: "atomic admission",
      expected: "one identity for duplicates, conflict on mismatch, busy rejects retryable work",
      actual: { first, duplicate, later },
    });
  });

  it("blocks a required dependent after failure but still runs its settled presenter", async () => {
    const worker = await start(join(directory, "failure"), "fail-triage");
    const reference = await worker.request("submit", request);
    const completed = await worker.request("wait", { principal: "alice", reference });
    expect(completed.result.status).toBe("degraded");
    expect(completed.result.nodes.map((node) => node.status)).toEqual([
      "failed",
      "blocked",
      "succeeded",
    ]);
    expect(completed.result.output).toBe("Presentation: triage failed; confirmation was blocked.");
    const calls = await worker.request("calls");
    expect(calls.map((call) => call.stage)).toEqual(["triage", "present"]);
    expect(calls[1].input).toContain('"status":"blocked"');
    cases.push({
      scenario: "required and settled edges",
      expected: "required work blocks, settled presenter reports failed coverage",
      actual: completed,
    });
  });

  it("rejects invalid requests, unavailable versions, and changed executable identities before dispatch", async () => {
    const state = join(directory, "invalid");
    const worker = await start(state);
    await expect(worker.request("submit", { ...request, version: 2 })).rejects.toThrow(
      "unknown_workflow",
    );
    await expect(
      worker.request("submit", { ...request, input: { text: "x".repeat(20_000) } }),
    ).rejects.toThrow("invalid_request");
    await expect(worker.request("submit", { ...request, extra: "unparsed" })).rejects.toThrow(
      "invalid_request",
    );
    expect(await worker.request("calls")).toEqual([]);
    const reference = await worker.request("submit", request);
    await worker.request("wait", { principal: "alice", reference });
    await worker.request("close");
    await expect(start(state, "normal", "0".repeat(64))).rejects.toThrow("incompatible_bundle");
    const reopened = await start(state);
    expect(
      (await reopened.request("wait", { principal: "alice", reference })).result.output,
    ).toContain("Presentation:");
    cases.push({
      scenario: "boundary rejection",
      expected: "invalid input and incompatible bundle never dispatch",
      actual: "rejected; original bundle still reads result",
    });
  });

  it("pins model execution when the embedding caller replaces its provider or mutates its catalog", async () => {
    const worker = await start(join(directory, "model-pin"), "hold-confirm");
    const reference = await worker.request("submit", request);
    await worker.request("at-confirm");
    await worker.request("replace-provider");
    await worker.request("release");
    const completed = await worker.request("wait", { principal: "alice", reference });
    expect(completed.result.output).toBe("Presentation: confirmed synthetic change.");
    const calls = await worker.request("calls");
    expect(calls.map((call) => call.baseUrl)).toEqual(Array(3).fill("http://localhost:0"));
    cases.push({
      scenario: "model pin against caller mutation",
      expected: "original provider and descriptor for every stage",
      actual: { completed, calls },
    });
  });

  it("keeps a wait bound to its original run when the caller mutates the reference", async () => {
    const worker = await start(join(directory, "wait-pin"), "hold-confirm");
    await worker.request("release");
    const previous = await worker.request("submit", request);
    await worker.request("wait", { principal: "alice", reference: previous });
    const current = await worker.request("submit", { ...request, requestId: "current" });
    const completed = await worker.request("wait-mutated", {
      principal: "alice",
      reference: current,
      other: previous,
    });
    expect(completed.reference).toEqual(current);
    cases.push({
      scenario: "wait reference mutation",
      expected: "original wait identity",
      actual: completed.reference,
    });
  });

  it.each(["cycle", "duplicate", "missing", "uncovered", "oversized"])(
    "rejects a %s definition before opening storage",
    async (mode) => {
      await expect(start(join(directory, `definition-${mode}`), `invalid-${mode}`)).rejects.toThrow(
        "invalid_definition",
      );
      cases.push({
        scenario: `invalid ${mode} definition`,
        expected: "rejected before dispatch",
        actual: "rejected",
      });
    },
  );

  it("rejects an incompatible bundle while work is pending, without stranding the original bundle", async () => {
    const state = join(directory, "pending-bundle");
    const first = await start(state, "hold-confirm");
    const reference = await first.request("submit", request);
    await first.request("at-confirm");
    await first.kill();
    await expect(start(state, "normal", "1".repeat(64))).rejects.toThrow("incompatible_bundle");
    const resumed = await start(state);
    expect((await resumed.request("wait", { principal: "alice", reference })).result.status).toBe(
      "succeeded",
    );
    cases.push({
      scenario: "pending incompatible bundle",
      expected: "no dispatch by incompatible executable; original resumes",
      actual: "passed",
    });
  });

  it.each(["empty-present", "oversized-present"])(
    "reports %s as a failed run result and releases capacity",
    async (mode) => {
      const worker = await start(join(directory, mode), mode);
      const reference = await worker.request("submit", request);
      const completed = await worker.request("wait", { principal: "alice", reference });
      expect(completed.result.status).toBe("failed");
      expect(completed.result.output).toBeNull();
      expect(completed.result.nodes.at(-1)).toMatchObject({
        status: "failed",
        reason: "output_contract",
      });
      const next = await worker.request("submit", { ...request, requestId: "next" });
      await worker.request("wait", { principal: "alice", reference: next });
      cases.push({
        scenario: mode,
        expected: "failed presenter is not reported as success; capacity is reusable",
        actual: completed,
      });
    },
  );

  it("keeps ownership bound to the filesystem identity when the directory pathname changes", async () => {
    const original = join(directory, "identity-original");
    const renamed = join(directory, "identity-renamed");
    const owner = await start(original);
    await rename(original, renamed);
    await expect(start(renamed)).rejects.toThrow("locked");
    await owner.kill();
    const successor = await start(renamed);
    await successor.request("close");
    cases.push({
      scenario: "filesystem identity ownership",
      expected: "a different pathname for the same directory cannot acquire ownership",
      actual: "passed",
    });
  });

  it("permits only one owner, including when the state directory has a symlink alias", async () => {
    const state = join(directory, "ownership");
    const owner = await start(state);
    await expect(start(state)).rejects.toThrow("locked");
    const alias = join(directory, "ownership-alias");
    await symlink(state, alias);
    await expect(start(alias)).rejects.toThrow("locked");
    await owner.kill();
    const successor = await start(state);
    const reference = await successor.request("submit", request);
    expect((await successor.request("wait", { principal: "alice", reference })).status).toBe(
      "completed",
    );
    cases.push({
      scenario: "exclusive owner and crash takeover",
      expected: "second open fails; kernel releases crashed owner",
      actual: "passed",
    });
  });
});
