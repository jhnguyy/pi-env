import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { testTempDir } from "../../../../src/testing/temp-dir";
import { createObsidianProvider, type ObsidianProviderOptions } from "../obsidian-provider";

export async function vaultFixture(
  initial: Record<string, string> = {},
  options: ObsidianProviderOptions = {},
) {
  const root = await testTempDir("pi-notes-");
  const vault = path.join(root, "vault");
  await mkdir(vault);
  for (const [notePath, content] of Object.entries(initial)) {
    const target = path.join(vault, notePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return { root, vault, provider: await createObsidianProvider(vault, options) };
}
