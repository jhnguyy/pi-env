import { afterEach, describe, expect, it } from "vitest";
import type { NotesProvider } from "../domain";
import {
  registerNotesProvider,
  resetNotesProviderRegistryForTests,
  resolveNotesProvider,
} from "../provider-registry";

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

afterEach(resetNotesProviderRegistryForTests);

describe("notes provider registry", () => {
  it("resolves a provider registered by another extension bundle", () => {
    const external = provider("notes-assistant");
    const unregister = registerNotesProvider(external);
    expect(resolveNotesProvider("notes-assistant")).toBe(external);
    unregister();
    expect(() => resolveNotesProvider("notes-assistant")).toThrow("not registered");
  });

  it("rejects duplicate and incomplete providers", () => {
    const same = provider("same");
    registerNotesProvider(same);
    expect(() => registerNotesProvider(same)).toThrow("already registered");
    expect(() => registerNotesProvider(provider("same"))).toThrow("already registered");
    expect(() => registerNotesProvider({ id: "incomplete" } as unknown as NotesProvider)).toThrow(
      "baseline interface",
    );
  });
});
