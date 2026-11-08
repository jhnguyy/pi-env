import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import type * as DurableNotes from "../../durable";
import type * as Domain from "../../domain";

const require = createRequire(import.meta.url);
for (const name of ["pi-coding-agent", "pi-agent-core", "pi-tui"]) {
  assert.throws(() => require.resolve(`@earendil-works/${name}`), { code: "MODULE_NOT_FOUND" });
}

const entry = "@pi-env/notes/durable";
const Notes: typeof DurableNotes = await import(entry);
let reads = 0;
const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected provider operation");
};
const provider: Domain.NotesProvider = {
  id: "artifact-fixture",
  index: unexpected,
  list: unexpected,
  search: unexpected,
  write: unexpected,
  delete: unexpected,
  async read(path, signal) {
    assert.equal(path, "wiki/topic.md");
    assert.ok(signal instanceof AbortSignal);
    reads++;
    return { path, content: "portable artifact", revision: "r1" };
  },
};
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("notes", { action: "read", path: "wiki/topic.md" }), {
    stopReason: "toolUse",
  }),
  fauxAssistantMessage("done"),
]);
const registry = createRegistry();
registry.install(Notes.createDurableNotesExtension(provider));
const context = BACKGROUND_CONTEXT;
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
try {
  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  const settled = await (
    await root.submit({ type: "input", content: "read the note" }, context)
  ).wait(context);
  assert.equal(settled.status, "done");
  const { items } = await root.entries({}, 100, undefined, context);
  const result = items.find(ToolResultEntry.is)?.model?.[0];
  assert.ok(result?.role === "toolResult");
  assert.equal(result.isError, false);
  assert.deepEqual(result.content, [
    { type: "text", text: '[Note path="wiki/topic.md" revision="r1"]\nportable artifact' },
  ]);
  assert.deepEqual(result.details, { action: "read", path: "wiki/topic.md", revision: "r1" });
  assert.equal(reads, 1);
} finally {
  await harness.close(context);
}
console.log("durable public export: read passed");
