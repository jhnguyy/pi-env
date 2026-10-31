import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  fauxProvider,
  fauxToolCall,
  fauxAssistantMessage,
  type TranscriptContext,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import notesExtension, { NotesProviderEvent } from "../index";
import type { NotesProvider } from "../domain";
import { createObsidianProvider } from "../obsidian-provider";
import * as ChildContext from "../../_shared/child-context";

const roots: string[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.abort();
    try {
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function owner(policy?: string, adapters: ExtensionFactory[] = []) {
  const cwd = await mkdtemp(join(tmpdir(), "notes-policy-"));
  roots.push(cwd);
  const agentDir = join(cwd, "agent");
  const vault = join(cwd, "vault");
  await mkdir(agentDir);
  await mkdir(join(vault, "_meta"), { recursive: true });
  await writeFile(join(vault, "note.md"), "original");
  if (policy !== undefined) await writeFile(join(vault, "_meta/overview.md"), policy);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      notes: adapters.length ? { provider: "late" } : { provider: "obsidian", vaultPath: vault },
    }),
  );
  const model = fauxProvider();
  const services = await ChildContext.withChildContext({ cwd, agentDir }, () =>
    createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
      resourceLoaderOptions: {
        extensionFactories: [
          {
            name: "model",
            factory: (pi) => {
              pi.registerProvider(model.provider);
            },
          },
          { name: "notes", factory: notesExtension },
          ...adapters.map((factory) => ({ name: "adapter", factory })),
        ],
      },
    }),
  );
  expect(services.diagnostics.filter((item) => item.type === "error")).toEqual([]);
  const { session, extensionsResult } = await createAgentSessionFromServices({
    services,
    model: model.getModel(),
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["notes"],
  });
  sessions.push(session);
  expect(extensionsResult.errors).toEqual([]);
  await session.bindExtensions({ mode: "print" });
  const request = async (args?: ToolCall["arguments"]) => {
    let seen: TranscriptContext | undefined;
    model.setResponses([
      (context) => {
        seen = structuredClone(context);
        return args
          ? fauxAssistantMessage(fauxToolCall("notes", args), { stopReason: "toolUse" })
          : fauxAssistantMessage("done");
      },
      ...(args ? [fauxAssistantMessage("done")] : []),
    ]);
    const start = session.messages.length;
    await session.prompt("Exercise notes policy.");
    await session.waitForIdle();
    expect(seen).toBeDefined();
    return {
      context: seen!,
      result: session.messages.slice(start).find((message) => message.role === "toolResult"),
    };
  };
  return { session, vault, request };
}

it("sends scoped policy with provenance to the model, reloads without stale fallback, and guards writes", async () => {
  const first = await owner("POLICY_ONE: consult [destination](destination.md) before writing.");
  const initial = await first.request();
  const policyMessages = initial.context.messages.filter((message) =>
    JSON.stringify(message).includes("POLICY_ONE"),
  );
  expect(policyMessages).toHaveLength(1);
  expect(policyMessages[0].role).toBe("user");
  expect(JSON.stringify(policyMessages[0])).toContain("lower-priority");
  expect(JSON.stringify(policyMessages[0])).toContain("obsidian");
  expect(JSON.stringify(policyMessages[0])).toContain("_meta/overview.md");
  const persisted = await (await createObsidianProvider(first.vault)).read("_meta/overview.md");
  expect(JSON.stringify(policyMessages[0])).toContain(persisted.revision);
  const tools = JSON.stringify(
    initial.context.messages.filter((message) => message.role === "system"),
  );
  expect(tools).not.toMatch(/Inbox|Worklog|projects\/|wiki\//);
  expect(
    (
      await first.request({
        action: "write",
        path: "created.md",
        content: "created",
        revision: null,
      })
    ).result,
  ).toMatchObject({ isError: false });
  expect(await readFile(join(first.vault, "created.md"), "utf8")).toBe("created");

  await writeFile(join(first.vault, "_meta/overview.md"), "POLICY_TWO");
  expect(JSON.stringify((await first.request()).context)).toContain("POLICY_ONE");
  await first.session.prompt("/notes-reload");
  const updated = JSON.stringify((await first.request()).context);
  expect(updated).toContain("POLICY_TWO");
  expect(updated).not.toContain("POLICY_ONE");
  expect(updated).not.toContain(persisted.revision);

  await writeFile(join(first.vault, "_meta/overview.md"), "é".repeat(8193));
  await first.session.prompt("/notes-reload");
  const failed = await first.request({ action: "read", path: "note.md" });
  expect(failed.result).toMatchObject({
    isError: false,
    content: [{ text: expect.stringContaining("original") }],
  });
  expect(JSON.stringify(failed.context)).not.toContain("POLICY_TWO");
  const blockedActions: ToolCall["arguments"][] = [
    { action: "write", path: "blocked.md", content: "no", revision: null },
    { action: "edit", path: "note.md", append: "no", revision: "any" },
    { action: "delete", path: "note.md", revision: "any" },
  ];
  for (const args of blockedActions) {
    expect((await first.request(args)).result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("policy") }],
    });
  }
  await writeFile(join(first.vault, "_meta/overview.md"), "RECOVERED");
  await first.session.prompt("/notes-reload");
  expect(
    (await first.request({ action: "write", path: "recovered.md", content: "yes", revision: null }))
      .result,
  ).toMatchObject({ isError: false });
});

it("keeps missing-policy reads and concurrent owners independent through shutdown", async () => {
  const [missing, loaded] = await Promise.all([owner(), owner("OTHER_OWNER_POLICY")]);
  const read = await missing.request({ action: "read", path: "note.md" });
  expect(read.result).toMatchObject({ isError: false });
  expect(JSON.stringify(read.context)).not.toContain("OTHER_OWNER_POLICY");
  expect(
    (await missing.request({ action: "write", path: "blocked.md", content: "no", revision: null }))
      .result,
  ).toMatchObject({ isError: true });
  await missing.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
  expect(JSON.stringify((await loaded.request()).context)).toContain("OTHER_OWNER_POLICY");
});

// This adapter double controls unavailable remote-service responses; Pi lifecycle,
// dispatch, validation, policy loading, and model context remain native.
function external(overrides: Partial<NotesProvider> = {}): NotesProvider {
  return {
    id: "late",
    index: async () => ({ text: "remote", policy: { path: "_meta/remote.md" } }),
    list: async () => [],
    read: async (path) => ({
      path,
      content: path === "_meta/remote.md" ? "REMOTE_POLICY" : "remote note",
      revision: "remote-revision",
    }),
    search: async () => [],
    write: async ({ path }) => ({ path, revision: "written" }),
    delete: async ({ path }) => ({ path }),
    ...overrides,
  };
}

function adapter(provider: NotesProvider): ExtensionFactory {
  return (pi) => {
    pi.events.emit(NotesProviderEvent.Register, { provider });
  };
}

it("loads an adapter registered after the notes factory and exposes its actual revision", async () => {
  const calls: string[] = [];
  const remote = external({
    read: async (path) => {
      calls.push(path);
      return {
        path,
        content: "REMOTE_POLICY [linked](not-loaded.md)",
        revision: "remote-revision",
      };
    },
  });
  const fixture = await owner(undefined, [adapter(remote)]);
  const received = JSON.stringify((await fixture.request()).context);
  expect(received).toContain("REMOTE_POLICY");
  expect(received).toContain("remote-revision");
  expect(received).toContain("_meta/remote.md");
  expect(calls).toEqual(["_meta/remote.md"]);
  expect(
    (await fixture.request({ action: "write", path: "new.md", content: "ok", revision: null }))
      .result,
  ).toMatchObject({ isError: false });
});

it.each([
  [
    "read failure",
    external({
      read: async (path) => {
        if (path === "_meta/remote.md") throw new Error("SYNTHETIC_PRIVATE_REMOTE_ERROR");
        return { path, content: "read available", revision: "r" };
      },
    }),
  ],
  [
    "invalid policy path",
    external({ index: async () => ({ text: "remote", policy: { path: "../escape.md" } }) }),
  ],
  [
    "wrong document",
    external({ read: async () => ({ path: "wrong.md", content: "not policy", revision: "r" }) }),
  ],
  [
    "empty revision",
    external({ read: async (path) => ({ path, content: "not policy", revision: "" }) }),
  ],
  ["blank policy", external({ read: async (path) => ({ path, content: "  ", revision: "r" }) })],
] as const)("fails closed without leaking remote errors: %s", async (_name, provider) => {
  const fixture = await owner(undefined, [adapter(provider)]);
  const read = await fixture.request({ action: "list" });
  expect(read.result).toMatchObject({ isError: false });
  const context = JSON.stringify(read.context);
  expect(context).toContain("Notes policy unavailable");
  expect(context).not.toContain("SYNTHETIC_PRIVATE_REMOTE_ERROR");
  expect(
    (await fixture.request({ action: "write", path: "blocked.md", content: "no", revision: null }))
      .result,
  ).toMatchObject({ isError: true });
});

it("aborts a timed-out remote load while leaving reads usable", async () => {
  let aborted = false;
  const remote = external({
    index: (_signal) =>
      new Promise((_resolve) => {
        _signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
      }),
  });
  const fixture = await owner(undefined, [adapter(remote)]);
  expect(aborted).toBe(true);
  expect((await fixture.request({ action: "read", path: "note.md" })).result).toMatchObject({
    isError: false,
  });
  expect(
    (await fixture.request({ action: "write", path: "blocked.md", content: "no", revision: null }))
      .result,
  ).toMatchObject({ isError: true });
});

it("cancels an in-flight reload at shutdown and rejects its late policy result", async () => {
  let hang = false;
  let release!: (value: Awaited<ReturnType<NotesProvider["read"]>>) => void;
  let enter!: () => void;
  let abort!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    abort = resolve;
  });
  const remote = external({
    read: async (path, signal) => {
      if (!hang) return { path, content: "BEFORE_SHUTDOWN", revision: "initial" };
      return new Promise((resolve) => {
        release = resolve;
        signal?.addEventListener("abort", () => abort(), { once: true });
        enter();
      });
    },
  });
  const fixture = await owner(undefined, [adapter(remote)]);
  hang = true;
  const reloading = fixture.session.prompt("/notes-reload");
  await entered;
  await fixture.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
  await aborted;
  release({ path: "_meta/remote.md", content: "LATE_POLICY", revision: "late" });
  await reloading;
  const after = await fixture.request({ action: "list" });
  expect(after.result).toMatchObject({ isError: true }); // shutdown also unregisters the adapter
  expect(JSON.stringify(after.context)).not.toMatch(/BEFORE_SHUTDOWN|LATE_POLICY/);
});
