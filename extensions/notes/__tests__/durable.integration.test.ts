import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  ToolResultEntry,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { build } from "esbuild";
import { createDurableNotesExtension } from "../durable";
import * as TempDir from "../../../src/testing/temp-dir";
import type { NotesProvider } from "../domain";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const context = BACKGROUND_CONTEXT;
const done = fauxAssistantMessage([fauxText("done")]);
const call = (args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage([fauxToolCall("notes", args)], { stopReason: "toolUse" });

function provider(): NotesProvider {
  return {
    id: "injected",
    index: vi.fn(async () => ({ text: "Use wiki for maintained knowledge." })),
    list: vi.fn(async () => ({ entries: [] })),
    read: vi.fn(async (path) => ({ path, content: "remote note", revision: "rev-1" })),
    search: vi.fn(async () => []),
    write: vi.fn(async (request) => ({ path: request.path, revision: "rev-2" })),
    delete: vi.fn(async (request) => ({ path: request.path })),
  };
}

async function open(
  source: NotesProvider,
  responses: FauxResponseStep[],
  storage: Storage = new MemoryStorage(),
) {
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(createDurableNotesExtension(source));
  const harness = await Harness.open(storage, { models, registry }, context);
  onTestFinished(() => harness.close(context));
  // No local execution environment, CLI settings, or vault is needed.
  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: "/remote/workspace" },
  });
  return { harness, root };
}

describe("durable notes", () => {
  it("bundles without coding-agent, agent-core, or terminal UI runtime dependencies", async () => {
    const config = JSON.parse(
      await readFile(new URL("../../../pi-build.config.json", import.meta.url), "utf8"),
    ) as { externals: string[] };
    const { metafile } = await build({
      entryPoints: [fileURLToPath(new URL("../durable.ts", import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      external: config.externals,
      write: false,
      metafile: true,
    });
    const imports = Object.values(metafile.outputs).flatMap((output) =>
      output.imports.map((item) => item.path),
    );
    expect(imports).toContain("@earendil-works/pi-durable");
    expect([...imports, ...Object.keys(metafile.inputs)]).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/@earendil-works\/pi-(coding-agent|agent-core|tui)/),
      ]),
    );
  });

  it("executes injected-provider reads and persists output, details, and shared guidance", async () => {
    const source = provider();
    const { root } = await open(source, [call({ action: "read", path: "wiki/topic.md" }), done]);
    const settled = await (
      await root.submit({ type: "input", content: "read" }, context)
    ).wait(context);
    expect(settled, JSON.stringify(settled)).toMatchObject({ status: "done" });
    const { items } = await root.entries({}, 100, undefined, context);
    const result = items.find(ToolResultEntry.is);
    expect(result?.model?.[0]).toMatchObject({
      role: "toolResult",
      isError: false,
      content: [
        { type: "text", text: '[Note path="wiki/topic.md" revision="rev-1"]\nremote note' },
      ],
    });
    expect(result?.model?.[0]).toMatchObject({
      details: { action: "read", path: "wiki/topic.md", revision: "rev-1" },
    });
    expect(items.find((item) => item.kind === "pi.system")?.model).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sections: expect.objectContaining({
            notes: expect.stringContaining("Never store secrets"),
          }),
        }),
      ]),
    );
    expect(source.read).toHaveBeenCalledWith("wiki/topic.md", expect.any(AbortSignal));
  });

  it("preserves revision preconditions and rejects invalid arguments before provider IO", async () => {
    const source = provider();
    const { root } = await open(source, [
      call({ action: "write", path: "wiki/topic.md", content: "updated", revision: "rev-1" }),
      call({ action: "write", path: "wiki/topic.md", content: "missing revision" }),
      call({ action: "delete", path: "../outside.md", revision: "rev-1" }),
      done,
    ]);
    await (await root.submit({ type: "input", content: "update" }, context)).wait(context);
    expect(source.write).toHaveBeenCalledExactlyOnceWith(
      {
        path: "wiki/topic.md",
        content: "updated",
        expectedRevision: "rev-1",
      },
      expect.any(AbortSignal),
    );
    expect(source.delete).not.toHaveBeenCalled();
    const { items } = await root.entries({ order: "ascending" }, 100, undefined, context);
    expect(items.filter(ToolResultEntry.is).map((item) => item.model?.[0])).toMatchObject([
      { isError: false },
      { isError: true },
      { isError: true },
    ]);
  });

  it("does not repeat an interrupted mutation after reopening durable storage", async () => {
    const directory = await TempDir.forTest("pi-env-notes-durable-");
    const source = provider();
    const performed = deferred<void>();
    vi.mocked(source.write).mockImplementation(async (_request, signal) => {
      if (!signal) throw new Error("Missing cancellation");
      // The external effect happened, but its confirmation has not reached the harness.
      performed.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const path = join(directory, "session.sqlite");
    const initial = await open(
      source,
      [
        call({
          action: "write",
          path: "wiki/topic.md",
          content: "update",
          revision: "rev-1",
        }),
      ],
      await openNodeSqliteStorage(path),
    );
    const submission = await initial.root.submit({ type: "input", content: "update" }, context);
    await performed.promise;
    await initial.harness.close(context);
    const next = await open(source, [done], await openNodeSqliteStorage(path));
    const resumed = await next.harness.submission(submission.id, context);
    expect(await resumed?.wait(context)).toMatchObject({ status: "done" });
    expect(source.write).toHaveBeenCalledOnce();
    const { items } = await next.root.entries({}, 100, undefined, context);
    expect(items.find(ToolResultEntry.is)?.model?.[0]).toMatchObject({ isError: true });
  });

  it("passes cancellation to the provider and waits for it to stop", async () => {
    const source = provider();
    const reached = deferred<AbortSignal>();
    const stopped = vi.fn();
    vi.mocked(source.read).mockImplementation(async (_path, signal) => {
      if (!signal) throw new Error("Missing cancellation");
      reached.resolve(signal);
      try {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } finally {
        stopped();
      }
      throw new Error("Read should have been aborted");
    });
    const { root } = await open(source, [call({ action: "read", path: "wiki/topic.md" }), done]);
    const submission = await root.submit({ type: "input", content: "read" }, context);
    const signal = await reached.promise;
    await root.abort(context);
    expect(signal.aborted).toBe(true);
    expect(stopped).toHaveBeenCalledOnce();
    expect(await submission.wait(context)).toMatchObject({
      status: "unanswered",
      reason: "aborted",
    });
  });
});
