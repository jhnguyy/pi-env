/**
 * @module ptc/wrapper-gen
 * @purpose Generates the PTC tool namespace and compatibility aliases.
 */
import type { PtcRuntimeSnapshot } from "./catalog";
import { toIdentifier } from "./catalog";
import { BLOCKED_TOOLS } from "./types";

export { toIdentifier } from "./catalog";

const RESERVED_GLOBALS = new Set(["tools", "settle"]);

function runtimeToolRecords(snapshot: PtcRuntimeSnapshot): string {
  return JSON.stringify({
    callable: snapshot.catalog.callable.map(({ name, key }) => ({ name, key })),
    unavailable: snapshot.catalog.unavailable.map(({ name, key }) => ({ name, key })),
    blocked: snapshot.catalog.blocked.map(({ name, key }) => ({ name, key })),
  });
}

function generateGlobalAliases(snapshot: PtcRuntimeSnapshot): string {
  const generated = new Set<string>();
  const aliases: string[] = [];

  for (const tool of snapshot.availableTools) {
    if (BLOCKED_TOOLS.has(tool.name)) continue;
    const key = toIdentifier(tool.name);
    if (RESERVED_GLOBALS.has(key) || generated.has(key)) continue;
    generated.add(key);
    aliases.push(`const ${key} = tools[${JSON.stringify(tool.name)}];`);
  }

  return aliases.join("\n");
}

export function generateRuntimeBindings(snapshot: PtcRuntimeSnapshot): string {
  return [
    `const tools = __create_tools(${runtimeToolRecords(snapshot)});`,
    generateGlobalAliases(snapshot),
  ]
    .filter(Boolean)
    .join("\n\n");
}
