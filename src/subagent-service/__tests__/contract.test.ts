import { expect, expectTypeOf, it } from "vitest";
import type { ServiceView } from "../client.js";
import type { Submit, Receipt, Snapshot, ResultPage } from "../contract.js";
import { ServiceChecks } from "../contract.js";
import type { NativeChildSnapshot } from "../../../.pi/extensions/subagent/child-types.js";
import { inspectionPage } from "../inspection.js";

it("infers RPC inputs, results and state from the service schemas", () => {
  expectTypeOf<Parameters<ServiceView["submit"]>[0]>().toEqualTypeOf<Submit>();
  expectTypeOf<Awaited<ReturnType<ServiceView["submit"]>>>().toEqualTypeOf<Receipt>();
  expectTypeOf<Awaited<ReturnType<ServiceView["result"]>>>().toEqualTypeOf<ResultPage>();
  expectTypeOf<ServiceView["snapshot"]["value"]>().toEqualTypeOf<Snapshot>();
});

function inspectionChild(patch: Partial<NativeChildSnapshot> = {}): NativeChildSnapshot {
  return {
    id: "child",
    runId: "run",
    name: "worker",
    task: "inspect the workspace",
    cwd: "/workspace",
    model: "provider/model",
    sessionFile: "/sessions/child.jsonl",
    systemPrompt: "system instructions",
    activeTools: ["read", "bash"],
    callableTools: ["read", "bash", "edit"],
    messages: [],
    inputs: [],
    state: "idle",
    ...patch,
  };
}

it("inspects configuration with ordered tools, pending result and ownership guidance", () => {
  const page = inspectionPage(inspectionChild(), { view: "configuration" });
  const text = [
    "Child: child",
    "Parent operation: run",
    "Cwd: /workspace",
    "Model: provider/model",
    "Native session: /sessions/child.jsonl",
    "",
    "Active tools",
    "read",
    "bash",
    "",
    "Callable tools",
    "read",
    "bash",
    "edit",
    "",
    "Initial result",
    "Pending",
    "",
    "Historical owners require explicit reopen. Never open an external transcript writer while the service owns this child.",
  ].join("\n");
  expect(page).toEqual({
    id: "child",
    runId: "run",
    name: "worker",
    task: "inspect the workspace",
    cwd: "/workspace",
    sessionFile: "/sessions/child.jsonl",
    model: "provider/model",
    state: "idle",
    view: "configuration",
    text,
    offset: 0,
    total: text.length,
    nextOffset: null,
    truncated: false,
  });
});

it.each([
  { isError: false, expected: "Completed" },
  { isError: true, expected: "Failed" },
])("reports $expected initial results independently of child state", ({ isError, expected }) => {
  const child = inspectionChild({ state: "closed" });
  child.initialResult = {
    name: child.name,
    task: child.task,
    toolNames: [],
    modelOverride: undefined,
    finalOutput: "result",
    toolCallCount: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    isError,
    turnLimitExceeded: false,
  };
  const page = inspectionPage(child, { view: "configuration" });
  expect(page.text).toContain(`\n\nInitial result\n${expected}\n\n`);
  expect(page.state).toBe("closed");
});

it.each([
  { value: undefined, expected: "unavailable" },
  { value: "", expected: "" },
])("preserves absent versus empty configuration values ($value)", ({ value, expected }) => {
  const page = inspectionPage(
    inspectionChild({ model: value, sessionFile: value, activeTools: [], callableTools: [] }),
    { view: "configuration" },
  );
  expect(page.text).toContain(`\nModel: ${expected}\nNative session: ${expected}\n\n`);
  expect(page.text).toContain("Active tools\n(none)\n\nCallable tools\n(none)\n\n");
  expect(page.model).toBe(value);
  expect(page.sessionFile).toBe(value);
});

it("pages configuration using sanitized text offsets and totals", () => {
  const child = inspectionChild({ id: "\u001b[31mchild\u001b[0m\u0000" });
  const page = inspectionPage(child, { view: "configuration", offset: 7, limit: 5 });
  const clean = inspectionPage(inspectionChild(), { view: "configuration" });
  expect(page.text).toBe("child");
  expect(page.offset).toBe(7);
  expect(page.nextOffset).toBe(12);
  expect(page.total).toBe(clean.total);
  expect(page.truncated).toBe(true);
  expect(inspectionPage(child, { view: "configuration", offset: clean.total })).toMatchObject({
    text: "",
    offset: clean.total,
    nextOffset: null,
    total: clean.total,
    truncated: true,
  });
});

const submit = { requestId: "request", runId: "run", name: "child", task: "task", cwd: "/tmp" };
it("checks admission strictly without coercing bounds, optional fields or discriminants", () => {
  expect(ServiceChecks.submit(submit)).toBe(true);
  for (const patch of [
    { maxTurns: "1" },
    { maxTurns: 0 },
    { maxTurns: 100_001 },
    { maxTurns: 1.5 },
    { name: "" },
    { task: "" },
    { tools: Array(129).fill("tool") },
    { reasoning: "invalid" },
    { workspaceAccess: "read" },
    { workspaceAccess: "write" },
    { workspaceAccess: "invalid" },
    { surprise: true },
    { capability: { kind: "retired" } },
  ])
    expect(ServiceChecks.submit({ ...submit, ...patch })).toBe(false);
  expect(ServiceChecks.submit({ ...submit, maxTurns: 1, reasoning: "xhigh" })).toBe(true);
  expect(
    ServiceChecks.input({
      requestId: "r",
      childId: "c",
      mode: "followUp",
      source: "human",
      text: "hi",
    }),
  ).toBe(true);
  expect(
    ServiceChecks.input({
      requestId: "r",
      childId: "c",
      mode: "followup",
      source: "human",
      text: "hi",
    }),
  ).toBe(false);
  expect(
    ServiceChecks.result({ operationId: "o", offset: Number.MAX_SAFE_INTEGER, limit: 16_384 }),
  ).toBe(true);
  expect(ServiceChecks.result({ operationId: "o", offset: -1 })).toBe(false);
});
