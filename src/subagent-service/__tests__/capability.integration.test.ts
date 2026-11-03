import { execFile } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { build, stop } from "esbuild";
import { expect, it } from "vitest";

it("preserves nested capability JSON for authority rejection before mutation through transport and direct runtime", async () => {
  const cache = fileURLToPath(new URL("../../../node_modules/.cache/", import.meta.url));
  await mkdir(cache, { recursive: true });
  const output = await mkdtemp(join(cache, "capability-"));
  try {
    const entry = join(output, "capability.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("./capability-worker.fixture.ts", import.meta.url))],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      target: "node24",
    });
    const result = await promisify(execFile)(process.execPath, [entry], {
      timeout: 15_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(output, "agent") },
    });
    expect(result.stdout).toContain(
      "capability direct/runtime transport rejection and restart passed",
    );
  } finally {
    await stop();
    await rm(output, { recursive: true, force: true });
  }
}, 20_000);
