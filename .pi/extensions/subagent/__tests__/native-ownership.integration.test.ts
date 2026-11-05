import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import * as ChildContext from "../../_shared/child-context";
import * as Config from "../config";
import * as Control from "../control";
import * as ChildTypes from "../child-types";
import { NativeChildOwner } from "../native-child";
import { testCleanup } from "./cleanup";

it("reopens the same native identity without replay and preserves input provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-ownership-"));
  const cleanup = testCleanup();
  cleanup(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const extension = join(agentDir, "provider.mjs");
  await writeFile(
    extension,
    `import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default function(pi) {
  const p = fauxProvider({ provider: 'ownership-native' });
  pi.registerProvider(p.provider);
  pi.on('input', event => {
    pi.appendEntry('observed-input', { text: event.text, source: event.source });
    p.setResponses([fauxAssistantMessage('answer:' + event.text)]);
  });
}`,
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: [extension],
      defaultProvider: "ownership-native",
      defaultModel: "faux-1",
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({ providers: { "ownership-native": { apiKey: "fixture-key" } } }),
  );
  const supervisor = new Control.SubagentRunSupervisor(
    "ownership",
    Config.resolveSubagentRuntimeConfig({}),
  );
  cleanup(() => supervisor.shutdown());
  const acquire = vi.spyOn(supervisor, "acquire");
  cleanup(() => acquire.mockRestore());
  const limits = Config.resolveSubagentRuntimeConfig({ maxConcurrentRuns: 1 });
  const owner = (manager: SessionManager) =>
    ChildContext.withChildContext(
      { cwd: root, agentDir },
      () =>
        new NativeChildOwner(
          { cwd: root, name: "ownership", task: "initial", toolNames: [] },
          { cwd: root, isProjectTrusted: () => true },
          manager,
          supervisor,
          { runId: "original-run", admission: { scopeId: "target", limits } },
        ),
    );
  const manager = SessionManager.create(root, join(root, "sessions"));
  const first = owner(manager);
  cleanup(() => first.close());
  await expect(first.input("too early", ChildTypes.NativeInputMode.Prompt)).rejects.toThrow(
    "not initialized",
  );
  const initial = await first.runInitial();
  expect(initial.details.isError).toBe(false);
  expect(acquire).toHaveBeenLastCalledWith(expect.objectContaining({ scopeId: "target", limits }));
  await expect(first.runInitial()).rejects.toThrow("uninitialized idle owner");
  await expect(first.reopen()).rejects.toThrow("already initialized");
  await first.input("human continuation", ChildTypes.NativeInputMode.Prompt);
  const saved = first.inspect();
  await first.close();
  const reopenedManager = SessionManager.open(saved.sessionFile!);
  // Invalid custom entries must not displace valid recorded provenance.
  reopenedManager.appendCustomEntry("subagent-input", {
    source: "unknown",
    mode: "prompt",
    text: "invalid",
    at: "now",
  });
  const reopened = owner(reopenedManager);
  cleanup(() => reopened.close());
  const observed = () =>
    reopenedManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "observed-input");
  const before = observed().length;
  await reopened.reopen({
    inputs: [{ source: "human", mode: "prompt", text: "stale metadata", at: "now" }],
    initialResult: initial.details,
  });
  expect(reopened.summary()).toMatchObject({
    id: saved.id,
    runId: saved.runId,
    sessionFile: saved.sessionFile,
    state: "idle",
  });
  expect(reopened.inspect().inputs).toEqual(saved.inputs);
  expect(reopened.inspect().initialResult).toEqual(initial.details);
  expect(reopened.inspect().messages).toEqual(saved.messages);
  expect(observed()).toHaveLength(before);
  await reopened.input(
    "coordinator continuation",
    ChildTypes.NativeInputMode.Prompt,
    ChildTypes.NativeInputSource.Coordinator,
  );
  await reopened.input("human again", ChildTypes.NativeInputMode.Prompt);
  expect(reopened.inspect().inputs.map(({ source, text }) => ({ source, text }))).toEqual([
    { source: "coordinator", text: "initial" },
    { source: "human", text: "human continuation" },
    { source: "coordinator", text: "coordinator continuation" },
    { source: "human", text: "human again" },
  ]);
  expect(observed().map((entry) => (entry.type === "custom" ? entry.data : undefined))).toEqual([
    { text: "initial", source: "extension" },
    { text: "human continuation", source: "interactive" },
    { text: "coordinator continuation", source: "extension" },
    { text: "human again", source: "interactive" },
  ]);
  expect(reopened.inspect().initialResult).toEqual(initial.details);
  expect(acquire.mock.calls).toHaveLength(5);
  expect(
    acquire.mock.calls.every(
      ([request]) => request.scopeId === "target" && request.limits === limits,
    ),
  ).toBe(true);

  const metadataOnly = owner(SessionManager.create(root, join(root, "metadata-sessions")));
  cleanup(() => metadataOnly.close());
  const inputs: ChildTypes.NativeChildInput[] = [
    { source: "coordinator", mode: "prompt", text: "historical task", at: "then" },
  ];
  await metadataOnly.reopen({ inputs, initialResult: initial.details });
  inputs[0].text = "mutated caller metadata";
  expect(metadataOnly.inspect().inputs).toEqual([
    { source: "coordinator", mode: "prompt", text: "historical task", at: "then" },
  ]);
  expect(metadataOnly.inspect().messages).toEqual([]);
}, 30000);
