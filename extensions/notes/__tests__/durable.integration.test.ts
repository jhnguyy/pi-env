import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
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
import * as Notes from "../durable";
import type * as Domain from "../domain";
import * as TempDir from "../../../src/testing/temp-dir";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const context = BACKGROUND_CONTEXT;
const done = fauxAssistantMessage("done");
const call = (args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall("notes", args), { stopReason: "toolUse" });

function provider(): Domain.NotesProvider {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected provider operation");
  };
  return {
    id: "injected",
    index: unexpected,
    list: unexpected,
    read: vi.fn(unexpected),
    search: unexpected,
    write: vi.fn(unexpected),
    delete: unexpected,
  };
}

async function open(
  source: Domain.NotesProvider,
  responses: FauxResponseStep[],
  storage: Storage = new MemoryStorage(),
) {
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(Notes.createDurableNotesExtension(source));
  const harness = await Harness.open(storage, { models, registry }, context);
  onTestFinished(() => harness.close(context));
  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  return { harness, root };
}

describe("durable notes lifecycle", () => {
  it("does not repeat an interrupted mutation after reopening durable storage", async () => {
    const directory = await TempDir.forTest("pi-env-notes-durable-");
    const source = provider();
    const performed = deferred<void>();
    vi.mocked(source.write).mockImplementationOnce(async (_request, signal) => {
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
