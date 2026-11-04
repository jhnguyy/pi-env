import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { runResolvedSubagentEffect } from "../execute";
import { serviceClientFixture } from "./service-client.fixture";

it("rejects executable callbacks before service admission or native effects, even with no selected tools", async () => {
  const execute = vi.fn();
  const custom: ToolDefinition = {
    name: "private",
    label: "Private",
    description: "Run-local callback",
    parameters: { type: "object" },
    execute,
  };
  const connection = serviceClientFixture();
  const submit = vi.spyOn(connection.view, "submit");
  for (const toolNames of [["private"], []]) {
    await expect(
      Effect.runPromise(
        runResolvedSubagentEffect(
          {
            name: "child",
            task: "Do not admit",
            cwd: "/fixture",
            toolNames,
            customTools: [custom],
          },
          {
            cwd: "/fixture",
            sessionManager: SessionManager.inMemory("/fixture"),
            isProjectTrusted: () => true,
          },
          { serviceConnection: connection },
        ),
      ),
    ).rejects.toThrow(/private tools cannot cross/);
  }
  expect(submit).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});
