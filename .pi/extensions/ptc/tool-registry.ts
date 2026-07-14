/**
 * @module ptc/tool-registry
 * @purpose Manages tool execute functions for PTC dispatch.
 *
 * Only ACTIVE built-in and explicitly registered extension tools are available
 * inside PTC. Built-ins are resolved via createXxxToolDefinition(cwd).
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  AgentToolResult,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { generateId } from "../_shared/id";
import { BLOCKED_TOOLS } from "./types";
import { listenForAgentTools } from "../_shared/agent-tools";
import { BUILT_IN_TOOL_CONTRACTS, BUILT_IN_TOOL_NAMES } from "../_shared/built-in-tools";
import { listenForPtcTools } from "../_shared/ptc-tools";

type ExecuteFn = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: ExtensionContext,
) => Promise<AgentToolResult<unknown>>;

/**
 * Minimal context sufficient for tool dispatch.
 * Built-in tools only need `cwd`. Extension tools receive the full ctx but
 * only ACTIVE captured tools can be dispatched. This allows ptc to run as a
 * subagent tool where full ExtensionContext isn't available.
 */
export type DispatchContext = { cwd: string } | ExtensionContext;

const BUILTIN_FACTORIES = Object.fromEntries(
  Object.entries(BUILT_IN_TOOL_CONTRACTS).map(([name, contract]) => [name, contract.definitionFactory]),
) as Record<string, (cwd: string) => ToolDefinition<any, any, any>>;  // eslint-disable-line @typescript-eslint/no-explicit-any
const BUILTIN_NAMES = BUILT_IN_TOOL_NAMES;

export class ToolRegistry {
  private readonly pi: ExtensionAPI;
  private extensionTools = new Map<string, ExecuteFn>();
  private builtinCache = new Map<string, ToolDefinition<any, any, any>>();  // eslint-disable-line @typescript-eslint/no-explicit-any

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.installAgentToolsListener(pi);
    this.installPtcToolsListener(pi);
  }

  private rememberTool(tool: { name: string; execute: ExecuteFn }): void {
    if (BLOCKED_TOOLS.has(tool.name) || BUILTIN_NAMES.has(tool.name)) return;
    this.extensionTools.set(tool.name, tool.execute);
  }

  private installAgentToolsListener(pi: ExtensionAPI): void {
    listenForAgentTools(pi, ({ tool }) =>
      this.rememberTool({
        name: tool.name,
        execute: (id, params, signal) => tool.execute(id, params as any, signal, undefined),
      }),
    );
  }

  private installPtcToolsListener(pi: ExtensionAPI): void {
    listenForPtcTools(pi, ({ tool }) => this.rememberTool(tool as unknown as { name: string; execute: ExecuteFn }));
  }

  /** Returns the active tools available inside PTC. */
  getAvailableTools(pi: ExtensionAPI): ToolInfo[] {
    const activeNames = new Set(pi.getActiveTools());
    const allTools = pi.getAllTools().filter((tool) => activeNames.has(tool.name));
    const unavailable: string[] = [];
    const available = allTools.filter((t) => {
      if (BLOCKED_TOOLS.has(t.name)) return false;
      if (t.sourceInfo.source === "builtin") return true;
      if (this.extensionTools.has(t.name)) return true;
      unavailable.push(t.name);
      return false;
    });
    if (unavailable.length > 0) {
      console.warn(`[ptc] The following tools are unavailable inside PTC: ${unavailable.join(", ")}.`);
    }
    return available;
  }

  async dispatch(
    toolName: string,
    params: Record<string, unknown>,
    cwd: string,
    signal: AbortSignal | undefined,
    ctx?: DispatchContext,
  ): Promise<string> {
    this.assertActive(toolName);
    const toolCallId = `ptc_${generateId()}`;
    const effectiveCtx = (ctx ?? { cwd }) as ExtensionContext;
    let result: AgentToolResult<unknown>;

    if (BUILTIN_NAMES.has(toolName)) {
      const cacheKey = `${cwd}:${toolName}`;
      let def = this.builtinCache.get(cacheKey);
      if (!def) {
        const factory = BUILTIN_FACTORIES[toolName];
        def = factory(cwd);
        this.builtinCache.set(cacheKey, def);
      }
      result = await def.execute(toolCallId, params as any, signal, undefined, effectiveCtx);
    } else {
      const execute = this.extensionTools.get(toolName);
      if (!execute) {
        throw new Error(
          `[ptc] Tool "${toolName}" is not available. ` +
            `It may be blocked or not registered for PTC.`,
        );
      }
      result = await execute(toolCallId, params, signal, undefined, effectiveCtx);
    }

    return extractText(result);
  }

  private assertActive(toolName: string): void {
    if (BLOCKED_TOOLS.has(toolName)) throw new Error(`[ptc] Tool "${toolName}" is blocked.`);
    if (!this.pi.getActiveTools().includes(toolName)) {
      throw new Error(`[ptc] Tool "${toolName}" is inactive. Activate it before calling it through ptc.`);
    }
  }
}

function extractText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
