import { it } from "@effect/vitest";
import { Deferred, Effect, Ref } from "effect";
import { beforeEach, describe, expect, vi } from "vitest";
import { FileCache, MAX_FILE_SIZE_BYTES } from "../file-cache";

const fsMocks = vi.hoisted(() => ({
  stat: vi.fn<(path: string) => Promise<{ size: number }>>(),
  readFile: vi.fn<(path: string, encoding: string) => Promise<string>>(),
}));

vi.mock("node:fs/promises", () => fsMocks);

beforeEach(() => {
  fsMocks.stat.mockReset().mockResolvedValue({ size: 1 });
  fsMocks.readFile.mockReset();
});

describe("FileCache", () => {
  it("keeps 64 least-recently-used entries", async () => {
    fsMocks.readFile.mockImplementation(async (path) => `content:${path}`);
    const cache = new FileCache();
    const paths = Array.from({ length: 65 }, (_, index) => `/file-${index}.ts`);

    for (const path of paths.slice(0, 64)) await cache.readFile(path);
    await cache.readFile(paths[0]!);
    await cache.readFile(paths[64]!);
    await cache.readFile(paths[0]!);
    await cache.readFile(paths[1]!);

    expect(fsMocks.readFile.mock.calls.filter(([path]) => path === paths[0])).toHaveLength(1);
    expect(fsMocks.readFile.mock.calls.filter(([path]) => path === paths[1])).toHaveLength(2);
    expect(fsMocks.readFile).toHaveBeenCalledTimes(66);
  });

  it("reloads invalidated entries and clears every cached path", async () => {
    const contents = new Map([
      ["/a.ts", "a:one"],
      ["/b.ts", "b:one"],
    ]);
    fsMocks.readFile.mockImplementation(async (path) => contents.get(path) ?? "");
    const cache = new FileCache();

    expect(await cache.readFile("/a.ts")).toBe("a:one");
    expect(await cache.readFile("/b.ts")).toBe("b:one");
    contents.set("/a.ts", "a:two");
    contents.set("/b.ts", "b:two");
    expect(await cache.readFile("/a.ts")).toBe("a:one");
    expect(await cache.readFile("/b.ts")).toBe("b:one");

    cache.invalidate("/a.ts");
    expect(await cache.readFile("/a.ts")).toBe("a:two");
    expect(await cache.readFile("/b.ts")).toBe("b:one");

    contents.set("/a.ts", "a:three");
    cache.clear();
    expect(await cache.readFile("/a.ts")).toBe("a:three");
    expect(await cache.readFile("/b.ts")).toBe("b:two");
  });

  it.effect("shares one in-flight lookup between concurrent reads of the same path", () =>
    Effect.gen(function* () {
      const context = yield* Effect.context();
      const runPromise = Effect.runPromiseWith(context);
      const lookupStarted = yield* Deferred.make<void>();
      const releaseLookup = yield* Deferred.make<void>();
      const lookupCount = yield* Ref.make(0);
      fsMocks.readFile.mockImplementation(async () =>
        runPromise(
          Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(lookupCount, (current) => current + 1);
            if (count === 1) yield* Deferred.succeed(lookupStarted, undefined);
            yield* Deferred.await(releaseLookup);
            return "shared";
          }),
        ),
      );
      const cache = new FileCache();

      const first = cache.readFile("/shared.ts");
      yield* Deferred.await(lookupStarted);
      const second = cache.readFile("/shared.ts");
      yield* Deferred.succeed(releaseLookup, undefined);

      expect(yield* Effect.promise(() => Promise.all([first, second]))).toEqual([
        "shared",
        "shared",
      ]);
      expect(yield* Ref.get(lookupCount)).toBe(1);
      expect(fsMocks.stat).toHaveBeenCalledTimes(1);
    }),
  );

  it("retries a file after an oversized result", async () => {
    fsMocks.stat
      .mockResolvedValueOnce({ size: MAX_FILE_SIZE_BYTES + 1 })
      .mockResolvedValueOnce({ size: 1 });
    fsMocks.readFile.mockResolvedValue("now-small");
    const cache = new FileCache();

    await expect(cache.readFile("/changing.ts")).resolves.toBeNull();
    await expect(cache.readFile("/changing.ts")).resolves.toBe("now-small");
    expect(fsMocks.stat).toHaveBeenCalledTimes(2);
    expect(fsMocks.readFile).toHaveBeenCalledTimes(1);
  });

  it("retries a file after a read failure", async () => {
    fsMocks.readFile.mockRejectedValueOnce(new Error("unreadable")).mockResolvedValueOnce("ready");
    const cache = new FileCache();

    await expect(cache.readFile("/retry.ts")).resolves.toBeNull();
    await expect(cache.readFile("/retry.ts")).resolves.toBe("ready");
    expect(fsMocks.stat).toHaveBeenCalledTimes(2);
    expect(fsMocks.readFile).toHaveBeenCalledTimes(2);
  });

  it("preserves line extraction and block expansion behavior", async () => {
    const contents = new Map([
      ["/lines.ts", " first \nsecond\nthird"],
      ["/block.ts", "function value() {\n  if (ready) {\n    return 1;\n  }\n}"],
      ["/plain.ts", "const value = 1;\nnext();\nlast();"],
      ["/empty.ts", ""],
    ]);
    fsMocks.readFile.mockImplementation(async (path) => contents.get(path) ?? "");
    const cache = new FileCache();

    await expect(cache.getLine("/lines.ts", 1)).resolves.toBe("first");
    await expect(cache.getLine("/lines.ts", 99)).resolves.toBe("");
    await expect(cache.extractLines("/lines.ts", 1, 2)).resolves.toBe("second\nthird");
    await expect(cache.expandToBlock("/block.ts", 0, 0)).resolves.toBe(4);
    await expect(cache.expandToBlock("/plain.ts", 0, 0, 2)).resolves.toBe(1);
    await expect(cache.expandToBlock("/plain.ts", 0, 10, 3)).resolves.toBe(2);
    await expect(cache.readFile("/empty.ts")).resolves.toBe("");
    await expect(cache.getLine("/empty.ts", 1)).resolves.toBe("");
    await expect(cache.extractLines("/empty.ts", 0, 0)).resolves.toBeNull();
    await expect(cache.expandToBlock("/empty.ts", 0, 7)).resolves.toBe(7);
  });
});
