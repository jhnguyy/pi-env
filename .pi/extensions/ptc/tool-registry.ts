/**
 * @module ptc/tool-registry
 * @purpose Manages tool execute functions and runtime discovery for PTC dispatch.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  AgentToolResult,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { generateId } from "../_shared/id";
import { listenForAgentTools, type ExtToolRegistration } from "../_shared/agent-tools";
import { BUILT_IN_TOOL_CONTRACTS, BUILT_IN_TOOL_NAMES } from "../_shared/built-in-tools";
import { listenForPtcTools, type PtcToolRegistration } from "../_shared/ptc-tools";
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
  ctx: ExtensionToolContext,
) => Promise<AgentToolResult<unknown>>;

export type DispatchContext = { cwd: string } | ExtensionContext;

type RememberedRegistration = ExtToolRegistration | PtcToolRegistration;

interface RememberedTool {
  readonly registration: RememberedRegistration;
  readonly execute: ExecuteFn;
}

const BUILTIN_NAMES = BUILT_IN_TOOL_NAMES;

export class ToolRegistry {
  private readonly pi: ExtensionAPI;
  private extensionTools = new Map<string, RememberedTool>();
  private builtinCache = new Map<string, AgentTool<any, any>>();
  private builtinDefinitions = new Map<string, ToolDefinition<any, any, any>>();
  private readonly stopListening: Array<() => void> = [];

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.start();
  }

  start(): void {
    if (this.stopListening.length > 0) return;
    this.installAgentToolsListener(this.pi);
    this.installPtcToolsListener(this.pi);
  }

  private rememberTool(registration: RememberedRegistration, tool: { name: string; execute: ExecuteFn }): void {
    if (BLOCKED_TOOLS.has(tool.name) || BUILTIN_NAMES.has(tool.name)) return;
    this.extensionTools.set(tool.name, { registration, execute: tool.execute });
  }

  private forgetTool(registration: RememberedRegistration, name: string): void {
    const remembered = this.extensionTools.get(name);
    if (remembered?.registration === registration) this.extensionTools.delete(name);
  }

  private installAgentToolsListener(pi: ExtensionAPI): void {
    const stop = listenForAgentTools(
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
    this.stopListening.push(stop);
  }

  private installPtcToolsListener(pi: ExtensionAPI): void {
    this.stopListening.push(
      listenForPtcTools(
        pi,
        (registration) => this.rememberTool(registration, registration.tool),
        (registration) => this.forgetTool(registration, registration.tool.name),
      ),
    );
  }

  dispose(): void {
    for (const stop of this.stopListening.splice(0)) stop();
    this.extensionTools.clear();
  }

  getRuntimeSnapshot(): PtcRuntimeSnapshot {
    const activeNames = new Set(this.pi.getActiveTools());
    const activeTools = this.pi.getAllTools().filter((tool) => activeNames.has(tool.name));
    const availableTools: ToolInfo[] = [];
    const unavailableNames: string[] = [];

    for (const tool of activeTools) {
      if (BLOCKED_TOOLS.has(tool.name)) continue;
      if (!callableExposure(tool.exposure)) {
        unavailableNames.push(tool.name);
      } else if (tool.sourceInfo.source === "builtin" || this.extensionTools.has(tool.name)) {
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
    // AgentTool registrations also run in child sessions, which only provide cwd.
    // Legacy PTC registrations can use the parent context when available.
    const effectiveCtx = (ctx ?? { cwd }) as ExtensionToolContext;
    let result: AgentToolResult<unknown>;

    if (BUILTIN_NAMES.has(toolName)) {
      const cacheKey = `${cwd}:${toolName}`;
      const contract = BUILT_IN_TOOL_CONTRACTS[toolName as keyof typeof BUILT_IN_TOOL_CONTRACTS];
      if (ctx) {
        let definition = this.builtinDefinitions.get(cacheKey);
        if (!definition) {
          definition = contract.definitionFactory(cwd);
          this.builtinDefinitions.set(cacheKey, definition);
        }
        result = await definition.execute(toolCallId, params, signal, undefined, effectiveCtx);
      } else {
        let agentTool = this.builtinCache.get(cacheKey);
        if (!agentTool) {
          agentTool = contract.agentFactory(cwd);
          this.builtinCache.set(cacheKey, agentTool);
        }
        result = await agentTool.execute(toolCallId, params, signal, undefined);
      }
    } else {
      result = await this.extensionTools
        .get(toolName)!
        .execute(toolCallId, params, signal, undefined, effectiveCtx);
    }

    const text = extractText(result);
    if (result.isError) throw new Error(text || `PTC tool "${toolName}" failed.`);
    return text;
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

    const exposure = this.pi.getAllTools().find((tool) => tool.name === toolName)?.exposure;
    if ((exposure && !callableExposure(exposure)) || (!BUILTIN_NAMES.has(toolName) && !captured)) {
      throw toolAccessError(
        PtcToolFailureClass.Unavailable,
        toolName,
        `PTC tool "${toolName}" is not available inside PTC. Call it directly.`,
      );
    }
  }
}

function callableExposure(exposure: ToolInfo["exposure"]): boolean {
  return exposure !== "model-only" && exposure !== "hidden";
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
