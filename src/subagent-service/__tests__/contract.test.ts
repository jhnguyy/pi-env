import { expect, expectTypeOf, it } from "vitest";
import type { ServiceView } from "../client.js";
import type { Submit, Receipt, Snapshot, ResultPage } from "../contract.js";
import { ServiceChecks } from "../contract.js";

it("infers RPC inputs, results and state from the service schemas", () => {
  expectTypeOf<Parameters<ServiceView["submit"]>[0]>().toEqualTypeOf<Submit>();
  expectTypeOf<Awaited<ReturnType<ServiceView["submit"]>>>().toEqualTypeOf<Receipt>();
  expectTypeOf<Awaited<ReturnType<ServiceView["result"]>>>().toEqualTypeOf<ResultPage>();
  expectTypeOf<ServiceView["snapshot"]["value"]>().toEqualTypeOf<Snapshot>();
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
    { workspaceAccess: "invalid" },
    { surprise: true },
    { capability: { kind: "retired" } },
  ])
    expect(ServiceChecks.submit({ ...submit, ...patch })).toBe(false);
  expect(
    ServiceChecks.submit({ ...submit, maxTurns: 1, reasoning: "xhigh", workspaceAccess: "read" }),
  ).toBe(true);
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
