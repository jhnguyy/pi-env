import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { getChildContext, withChildContext } from "../_shared/child-context";

// SDK factory tests cover normal loading; separately bundled module identity is the gap here.
it("shares creation context across bundles and restores nested, failed, and concurrent scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "child-context-bundles-"));
  try {
    const bundle = await build({
      entryPoints: [resolve(".pi/extensions/_shared/child-context.ts")],
      bundle: true, platform: "node", format: "esm", write: false,
    });
    await Promise.all(["one", "two"].map((name) => writeFile(join(root, `${name}.mjs`), bundle.outputFiles[0].text)));
    const [one, two] = await Promise.all(["one", "two"].map((name) => import(/* @vite-ignore */ pathToFileURL(join(root, `${name}.mjs`)).href)));
    const originalCwd = process.cwd();
    await Promise.all(["a", "b"].map((id) => withChildContext({ cwd: `/${id}`, agentDir: `/agent/${id}`, id }, async () => {
      await Promise.resolve();
      expect(one.getChildContext()).toEqual({ cwd: `/${id}`, agentDir: `/agent/${id}`, id });
      expect(() => two.withChildContext({ cwd: "/nested", agentDir: "/nested-agent" }, () => {
        expect(getChildContext()?.cwd).toBe("/nested");
        throw new Error("factory failed");
      })).toThrow("factory failed");
      expect(two.getChildContext()?.id).toBe(id);
    })));
    expect(getChildContext()).toBeUndefined();
    expect(one.getChildContext()).toBeUndefined();
    expect(process.cwd()).toBe(originalCwd);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
