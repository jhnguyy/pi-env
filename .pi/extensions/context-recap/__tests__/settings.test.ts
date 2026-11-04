import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { warmingBlock } from "../lifetime";

it("uses only global native warming ownership and suppresses uncertain snapshots safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "recap-settings-"));
  const agent = join(root, "agent");
  const project = join(root, ".pi");
  onTestFinished(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(agent);
  await mkdir(project);
  vi.stubEnv("PI_CODING_AGENT_DIR", agent);
  expect(warmingBlock(root)).toBeUndefined();
  await writeFile(join(project, "settings.json"), JSON.stringify({ cacheWarming: "idle" }));
  expect(warmingBlock(root)).toBeUndefined();
  await writeFile(join(agent, "settings.json"), JSON.stringify({ cacheWarming: "idle" }));
  await writeFile(join(project, "settings.json"), JSON.stringify({ cacheWarming: "off" }));
  expect(warmingBlock(root)).toBe("native idle cache warming enabled");
  for (const content of ["SENSITIVE_SENTINEL", "[]", '{"cacheWarming":"SENSITIVE_SENTINEL"}']) {
    await writeFile(join(agent, "settings.json"), content);
    expect(warmingBlock(root)).toBe(
      "settings uncertain; repair settings.json before enabling automatic recap",
    );
    expect(warmingBlock(root)).not.toContain("SENSITIVE_SENTINEL");
  }
});
