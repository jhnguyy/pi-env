import { describe, expect, it, onTestFinished } from "vitest";
import type { NotesProvider } from "../domain";
import { registerNotesProvider, resolveNotesProvider } from "../provider-registry";

function provider(id: string): NotesProvider {
  return {
    id,
    index: async () => ({ text: "Store conventions" }),
    list: async () => [],
    read: async (path) => ({ path, content: "", revision: "revision" }),
    search: async () => [],
    resolve: async () => ({ path: "today.md", content: "", revision: "revision" }),
    write: async (request) => ({ path: request.path, revision: "next" }),
    delete: async (request) => ({ path: request.path }),
  };
}


describe("notes provider registry", () => {
  it("resolves a provider registered by another extension bundle", () => {
    const external = provider("notes-assistant");
    const unregister = registerNotesProvider(external);
    onTestFinished(unregister);
    expect(resolveNotesProvider("notes-assistant")).toBe(external);
    unregister();
    expect(() => resolveNotesProvider("notes-assistant")).toThrow("not registered");
  });

  it("rejects duplicate and incomplete providers", () => {
    const same = provider("same");
    onTestFinished(registerNotesProvider(same));
    expect(() => registerNotesProvider(same)).toThrow("already registered");
    expect(() => registerNotesProvider(provider("same"))).toThrow("already registered");
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The incomplete literal independently proves registry validation rejects missing provider methods.
    expect(() => registerNotesProvider({ id: "incomplete" } as unknown as NotesProvider)).toThrow(
      "baseline interface",
    );
  });
});
