import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { BLOCKED_TOOLS, PtcToolFailureClass, type PtcToolFailureClass as FailureClass } from "./types";

export interface PtcCallableTool {
  readonly name: string;
  readonly key: string;
  readonly aliases: readonly string[];
  readonly declaration: string;
}

export interface PtcUnavailableTool {
  readonly name: string;
  readonly key: string;
  readonly class: FailureClass;
  readonly reason: string;
  readonly directCallRequired: boolean;
}

export type PtcBlockedTool = PtcUnavailableTool;

export interface PtcToolCatalog {
  readonly nestedReturnType: "Promise<string>";
  readonly callable: readonly PtcCallableTool[];
  readonly unavailable: readonly PtcUnavailableTool[];
  readonly blocked: readonly PtcBlockedTool[];
}

export interface PtcRuntimeSnapshot {
  readonly availableTools: readonly ToolInfo[];
  readonly catalog: PtcToolCatalog;
}

export function toIdentifier(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_$]/g, "_");
  return /^[0-9]/.test(safe) ? `_${safe}` : safe;
}

function aliasesFor(name: string): string[] {
  const key = toIdentifier(name);
  return key === name ? [key] : [key, name];
}

function declarationFor(name: string): string {
  return `${toIdentifier(name)}(args?: Record<string, unknown>): Promise<string>`;
}

export function createPtcToolCatalog(
  availableTools: readonly ToolInfo[],
  unavailableNames: readonly string[],
): PtcToolCatalog {
  const callable = availableTools
    .filter((tool) => !BLOCKED_TOOLS.has(tool.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => ({
      name: tool.name,
      key: toIdentifier(tool.name),
      aliases: aliasesFor(tool.name),
      declaration: declarationFor(tool.name),
    }));
  const unavailable = [...unavailableNames]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      key: toIdentifier(name),
      class: PtcToolFailureClass.Unavailable,
      reason: "This active direct tool has no PTC dispatcher. Call it directly.",
      directCallRequired: true,
    }));
  const blocked = [...BLOCKED_TOOLS]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      key: toIdentifier(name),
      class: PtcToolFailureClass.Blocked,
      reason: "This tool is blocked inside PTC. Call it directly.",
      directCallRequired: true,
    }));

  return {
    nestedReturnType: "Promise<string>",
    callable,
    unavailable,
    blocked,
  };
}

function propertySignature(name: string): string {
  return `${JSON.stringify(name)}(args?: Record<string, unknown>): Promise<string>;`;
}

function declarationBlock(catalog: PtcToolCatalog): string {
  const namespaceMembers: string[] = [];
  const namespaceKeys = new Set<string>();
  for (const tool of catalog.callable) {
    for (const alias of tool.aliases) {
      if (namespaceKeys.has(alias)) continue;
      namespaceKeys.add(alias);
      namespaceMembers.push(`  ${propertySignature(alias)}`);
    }
  }

  const reservedGlobals = new Set(["tools", "settle"]);
  const globalAliases: string[] = [];
  const globalKeys = new Set<string>();
  for (const tool of catalog.callable) {
    if (reservedGlobals.has(tool.key) || globalKeys.has(tool.key)) continue;
    globalKeys.add(tool.key);
    globalAliases.push(
      `declare function ${tool.key}(args?: Record<string, unknown>): Promise<string>;`,
    );
  }

  return [
    "type PtcSettledError = {",
    '  class: "blocked-tool" | "unavailable-tool" | "inactive-tool" | "unknown-tool" | "nested-tool" | "user-script";',
    "  message: string;",
    "  tool?: string;",
    "};",
    "type Settled<T> =",
    "  | { ok: true; value: T }",
    "  | { ok: false; error: PtcSettledError };",
    "declare const tools: {",
    ...namespaceMembers,
    "};",
    ...globalAliases,
    "declare function settle<T>(promise: Promise<T>): Promise<Settled<T>>;",
  ].join("\n");
}

export function formatPtcInspection(catalog: PtcToolCatalog): string {
  const unavailable =
    catalog.unavailable.length === 0
      ? ["- (none)"]
      : catalog.unavailable.map((tool) => `- ${tool.name}: ${tool.reason}`);
  const blocked = catalog.blocked.map((tool) => `- ${tool.name}: ${tool.reason}`);

  return [
    `Nested tool result: ${catalog.nestedReturnType} (plain text).`,
    "",
    `Callable tools (${catalog.callable.length})`,
    "```ts",
    declarationBlock(catalog),
    "```",
    "",
    `Active direct-only tools (${catalog.unavailable.length})`,
    ...unavailable,
    "",
    `Blocked tools (${catalog.blocked.length})`,
    ...blocked,
  ].join("\n");
}
