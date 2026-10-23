import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, onTestFinished, vi } from "vitest";
import watcher from "@parcel/watcher";
import { LspBackend } from "../backend";
import { BACKEND_CONFIGS } from "../backend-configs";
import { FileWatchers } from "../file-watchers";

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "lsp-watch-[literal]-"));
  const watchers = new FileWatchers();
  onTestFinished(async () => {
    const failures: unknown[] = [];
    try {
      await watchers.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "Watcher fixture cleanup failed");
  });
  const changes: { path: string; type: number }[] = [];
  const errors: Error[] = [];
  const register = (pattern: string, base = root) =>
    watchers.register(
      [
        {
          id: "files",
          method: "workspace/didChangeWatchedFiles",
          registerOptions: {
            watchers: [{ globPattern: { baseUri: pathToFileURL(base).href, pattern } }],
          },
        },
      ],
      root,
      (path, type) => changes.push({ path, type }),
      (error) => errors.push(error),
    );
  return { root, register, changes, errors };
}

// The real server controls its globs, so it cannot exercise arbitrary patterns and base URIs.
it("watches hidden files under a literal base URI and replaces registrations", async () => {
  const { root, register, changes, errors } = createFixture();
  mkdirSync(join(root, ".hidden"));
  await register("**/*.ts");
  const first = join(root, ".hidden", "first.ts");
  writeFileSync(first, "export {};");
  await expect.poll(() => changes).toContainEqual({ path: first, type: 1 });

  await register("**/*.js");
  const second = join(root, ".hidden", "second.js");
  writeFileSync(second, "export {};");
  await expect.poll(() => changes).toContainEqual({ path: second, type: 1 });
  expect(errors).toEqual([]);
});

it("keeps directory move events that can affect a registered descendant glob", async () => {
  const { root, register, changes } = createFixture();
  mkdirSync(join(root, "before"));
  writeFileSync(join(root, "before", "file.ts"), "export {};");
  await register("**/*.ts");
  renameSync(join(root, "before"), join(root, "after"));
  await expect.poll(() => changes).toContainEqual({ path: join(root, "before"), type: 3 });
  await expect.poll(() => changes).toContainEqual({ path: join(root, "after"), type: 1 });
});

it("reports a removed subscription root instead of leaving a silently stale watcher", async () => {
  const { root, register, errors } = createFixture();
  await register("**/*.ts");
  const physicalRoot = realpathSync(root);
  rmSync(root, { recursive: true });
  await expect
    .poll(() => errors.map((error) => error.message))
    .toContain(`Watched directory was removed: ${physicalRoot}`);
});

it("reports a populated directory moved into an initially missing watch base", async () => {
  const { root, register, changes } = createFixture();
  const staging = join(root, "staging");
  const missing = join(root, "missing");
  mkdirSync(staging);
  writeFileSync(join(staging, "package.json"), "{}");
  await register("package.json", missing);
  renameSync(staging, missing);
  await expect.poll(() => changes).toContainEqual({ path: missing, type: 1 });
});

it("allows backend restart after a watcher cleanup failure", async () => {
  const { root } = createFixture();
  const path = join(root, "main.ts");
  const uri = pathToFileURL(path).href;
  writeFileSync(path, "const value: string = 42;");
  writeFileSync(join(root, "tsconfig.json"), "{}");
  const backend = new LspBackend(BACKEND_CONFIGS[0]);
  onTestFinished(async () => {
    if (backend.isRunning) await backend.shutdown();
  });
  const subscribe = watcher.subscribe;
  // Native unsubscribe failures cannot be induced reliably. Release the real subscription first.
  const failure = vi.spyOn(watcher, "subscribe").mockImplementation(async (...args) => {
    const subscription = await subscribe(...args);
    return {
      unsubscribe: async () => {
        await subscription.unsubscribe();
        throw new Error("injected watcher cleanup failure");
      },
    };
  });
  onTestFinished(() => failure.mockRestore());
  await backend.ensureFile(path);
  await backend.waitForDiagnostics(uri);
  await expect(backend.shutdown()).rejects.toThrow("File watcher cleanup failed");
  failure.mockRestore();
  await backend.ensureFile(path);
  expect(backend.isRunning).toBe(true);
  await backend.shutdown();
});

it("maps physical watcher events back to a symlink base URI", async () => {
  const { root, register, changes } = createFixture();
  const target = join(root, "target");
  const alias = join(root, "alias");
  mkdirSync(target);
  symlinkSync(target, alias, "junction");
  await register("*.ts", alias);
  writeFileSync(join(target, "file.ts"), "export {};");
  await expect.poll(() => changes).toContainEqual({ path: join(alias, "file.ts"), type: 1 });
});
