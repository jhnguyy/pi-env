/**
 * @module ptc/tool-registry
 * @purpose Manages tool execute functions and runtime discovery for PTC dispatch.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  AgentToolResult,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { generateId } from "../_shared/id";
import { listenForAgentTools } from "../_shared/agent-tools";
import { BUILT_IN_TOOL_CONTRACTS, BUILT_IN_TOOL_NAMES } from "../_shared/built-in-tools";
import { listenForPtcTools } from "../_shared/ptc-tools";
import { createPtcToolCatalog, type PtcRuntimeSnapshot } from "./catalog";
import {
  BLOCKED_TOOLS,
  PtcToolDispatchError,
  PtcToolFailureClass,
  type PtcToolFailureClass as FailureClass,
} from "./types";

type ExecuteFn = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: ExtensionContext,
) => Promise<AgentToolResult<unknown>>;

export type DispatchContext = { cwd: string } | ExtensionContext;

interface RememberedTool {
  readonly registration: object;
  readonly execute: ExecuteFn;
}

const BUILTIN_FACTORIES = Object.fromEntries(
  Object.entries(BUILT_IN_TOOL_CONTRACTS).map(([name, contract]) => [
    name,
    contract.definitionFactory,
  ]),
) as Record<string, (cwd: string) => ToolDefinition<any, any, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const BUILTIN_NAMES = BUILT_IN_TOOL_NAMES;

export class ToolRegistry {
  private readonly pi: ExtensionAPI;
  private extensionTools = new Map<string, RememberedTool>();
  private builtinCache = new Map<string, ToolDefinition<any, any, any>>(); // eslint-disable-line @typescript-eslint/no-explicit-any

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.installAgentToolsListener(pi);
    this.installPtcToolsListener(pi);
  }

  private rememberTool(registration: object, tool: { name: string; execute: ExecuteFn }): void {
    if (BLOCKED_TOOLS.has(tool.name) || BUILTIN_NAMES.has(tool.name)) return;
    this.extensionTools.set(tool.name, { registration, execute: tool.execute });
  }

  private forgetTool(registration: object, name: string): void {
    const remembered = this.extensionTools.get(name);
    if (remembered?.registration === registration) this.extensionTools.delete(name);
  }

  private installAgentToolsListener(pi: ExtensionAPI): void {
    listenForAgentTools(
      pi,
      (registration) => {
        if (registration.audience === "dag") return;
        this.rememberTool(registration, {
          name: registration.tool.name,
          execute: (id, params, signal) =>
            registration.tool.execute(id, params, signal, undefined),
        });
      },
      (registration) => this.forgetTool(registration, registration.tool.name),
    );
  }

  private installPtcToolsListener(pi: ExtensionAPI): void {
    listenForPtcTools(pi, (registration) =>
      this.rememberTool(registration, registration.tool),
    );
  }

  getRuntimeSnapshot(): PtcRuntimeSnapshot {
    const activeNames = new Set(this.pi.getActiveTools());
    const activeTools = this.pi.getAllTools().filter((tool) => activeNames.has(tool.name));
    const availableTools: ToolInfo[] = [];
    const unavailableNames: string[] = [];

    for (const tool of activeTools) {
      if (BLOCKED_TOOLS.has(tool.name)) continue;
      if (tool.sourceInfo.source === "builtin" || this.extensionTools.has(tool.name)) {
        availableTools.push(tool);
      } else {
        unavailableNames.push(tool.name);
      }
    }

    return {
      availableTools,
      catalog: createPtcToolCatalog(availableTools, unavailableNames),
    };
  }

  getAvailableTools(): ToolInfo[] {
    return [...this.getRuntimeSnapshot().availableTools];
  }

  async dispatch(
    toolName: string,
    params: Record<string, unknown>,
    cwd: string,
    signal: AbortSignal | undefined,
    ctx?: DispatchContext,
  ): Promise<string> {
    this.assertCallable(toolName);
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
      result = await def.execute(toolCallId, params, signal, undefined, effectiveCtx);
    } else {
      result = await this.extensionTools
        .get(toolName)!
        .execute(toolCallId, params, signal, undefined, effectiveCtx);
    }

    return extractText(result);
  }

  private assertCallable(toolName: string): void {
    if (BLOCKED_TOOLS.has(toolName)) {
      throw toolAccessError(
        PtcToolFailureClass.Blocked,
        toolName,
        `PTC blocked tool "${toolName}". Call it directly, not inside PTC.`,
      );
    }

    const active = this.pi.getActiveTools().includes(toolName);
    const captured = this.extensionTools.has(toolName);
    const known = captured || this.pi.getAllTools().some((tool) => tool.name === toolName);
    if (!known && !active) {
      throw toolAccessError(
        PtcToolFailureClass.Unknown,
        toolName,
        `PTC unknown tool "${toolName}". Call PTC with action="inspect" to view current tools.`,
      );
    }

    if (!active) {
      throw toolAccessError(
        PtcToolFailureClass.Inactive,
        toolName,
        `PTC inactive tool "${toolName}". Activate it, then start a new PTC run.`,
      );
    }

    if (!BUILTIN_NAMES.has(toolName) && !captured) {
      throw toolAccessError(
        PtcToolFailureClass.Unavailable,
        toolName,
        `PTC tool "${toolName}" is not available inside PTC. It has no PTC dispatcher. Call it directly.`,
      );
    }
  }
}

function toolAccessError(
  failureClass: FailureClass,
  tool: string,
  message: string,
): PtcToolDispatchError {
  return new PtcToolDispatchError({ class: failureClass, tool, message });
}

function extractText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}
