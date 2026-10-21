import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";
import { createObsidianProvider, type ObsidianProviderOptions } from "../obsidian-provider";

export async function vaultFixture(
  initial: Record<string, string> = {},
  options: ObsidianProviderOptions = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-notes-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");
  await mkdir(vault);
  for (const [notePath, content] of Object.entries(initial)) {
    const target = path.join(vault, notePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return { root, vault, provider: await createObsidianProvider(vault, options) };
}
