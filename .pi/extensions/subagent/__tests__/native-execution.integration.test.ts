import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { NativeChildOwner } from "../native-child";
import * as ChildTypes from "../child-types";
import * as Control from "../control";
import * as Config from "../config";
import * as ChildContext from "../../_shared/child-context";
import { settleOperations, testCleanup } from "./cleanup";

// Registered-tool scenarios own configuration, selection and persistence.
// Hold the tool after abort here to prove close retains its lease until settlement.
it("holds native ownership until close settles and rejects overlapping input", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-child-active-"));
  const cleanup = testCleanup();
  cleanup(() => rm(root, { recursive: true, force: true }));
  let child: ChildTypes.NativeChildSession | undefined;
  const operations: Promise<unknown>[] = [];
  const { Type } = await import("typebox");
  const supervisor = new Control.SubagentRunSupervisor(
    "native-test",
    Config.resolveSubagentRuntimeConfig({}),
  );
  cleanup(() => supervisor.shutdown());
  const blocker = await supervisor.acquire({
    runId: "blocker",
    cwd: root,
    workspaceAccess: Control.WorkspaceAccess.Write,
  });
  let enter!: () => void;
  let release!: () => void;
  let aborted!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sawAbort = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  cleanup(
    () => {
      blocker.release();
      release();
    },
    () => child?.close(),
    () => supervisor.shutdown(),
    () => settleOperations(operations),
  );
  {
    await mkdir(join(root, ".pi"), { recursive: true });
    const extension = join(root, ".pi", "provider.mjs");
    await writeFile(
      extension,
      `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default function(pi) {
 const p = fauxProvider({provider:'gated-child'});
 p.setResponses([fauxAssistantMessage(fauxToolCall('gate',{}),{stopReason:'toolUse'}),fauxAssistantMessage('done')]);
 pi.registerProvider(p.provider);
 pi.on('session_shutdown', () => { pi.appendEntry('shutdown-hook',{}); });
}`,
    );
    await writeFile(
      join(root, ".pi", "settings.json"),
      JSON.stringify({ extensions: [extension] }),
    );
    const ctx = {
      cwd: root,
      isProjectTrusted: () => true,
    };
    const owner = ChildContext.withChildContext(
      { cwd: root, agentDir: join(root, "agent") },
      () =>
        new NativeChildOwner(
          {
            name: "gated",
            task: "run gate",
            cwd: root,
            modelOverride: "gated-child/faux-1",
            toolNames: ["gate"],
            customTools: [
              {
                name: "gate",
                label: "Gate",
                description: "Cooperative gated test tool",
                parameters: Type.Object({}),
                async execute(_id, _params, signal) {
                  signal?.addEventListener("abort", aborted, { once: true });
                  enter();
                  await gate;
                  return { content: [{ type: "text", text: "settled" }], details: {} };
                },
              },
            ],
          },
          ctx,
          SessionManager.create(root, join(root, "children")),
          supervisor,
          {},
        ),
    );
    child = owner;
    supervisor.retainChild(owner);
    const running = owner.runInitial();
    operations.push(running);
    expect(child.inspect().state).toBe("queued");
    await expect(
      child.input("not yet streaming", ChildTypes.NativeInputMode.Prompt),
    ).rejects.toThrow();
    blocker.release();
    await entered;
    await expect(child.input("overlap", ChildTypes.NativeInputMode.Prompt)).rejects.toThrow();
    let closed = false;
    const closing = child.close().then(() => {
      closed = true;
    });
    operations.push(closing);
    await sawAbort;
    let competingAdmitted = false;
    const competing = supervisor
      .acquire({ runId: "competing", cwd: root, workspaceAccess: Control.WorkspaceAccess.Write })
      .then((lease) => {
        competingAdmitted = true;
        lease.release();
      });
    operations.push(competing);
    await Promise.resolve();
    expect(competingAdmitted).toBe(false);
    expect(closed).toBe(false);
    expect(child.inspect().state).toBe("closing");
    await expect(child.input("too late", ChildTypes.NativeInputMode.Prompt)).rejects.toThrow();
    release();
    await closing;
    await running;
    await competing;
    expect(child.inspect().state).toBe("closed");
    await child.close();
    const entries = SessionManager.open(child.inspect().sessionFile!).getEntries();
    expect(
      entries.filter((e) => e.type === "custom" && e.customType === "shutdown-hook"),
    ).toHaveLength(1);
  }
}, 30000);
