/**
 * @module ptc/tool-registry
 * @purpose Manages tool execute functions for PTC dispatch.
 *
 * Built-in tools (read, bash, etc.) are resolved via createXxxToolDefinition(cwd)
 * from pi 0.62.0+. Extension tools are captured via a registerTool() intercept
 * installed at construction time — the only viable approach until pi exposes
 * pi.executeTool() upstream (see TODO below).
 *
 * Load-order note: extensions that load BEFORE ptc will have already called
 * registerTool() before the intercept is installed, so their execute functions
 * won't be captured. They are excluded from the available-tool list.
 *
 * Design doc: projects/homelab/ptc_extension_design.md
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  AgentToolResult,
  ToolDefinition,
  ToolInfo,
} from "@mariozechner/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { generateId } from "../_shared/id";
import { BLOCKED_TOOLS } from "./types";

type ExecuteFn = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: ExtensionContext,
) => Promise<AgentToolResult<unknown>>;

// Single source of truth for built-in tools: name → factory function.
// BUILTIN_NAMES is derived so both stay in sync automatically.
// Cast required: each factory has distinct generic ToolDefinition return types.
const BUILTIN_FACTORIES = {
  read:  createReadToolDefinition,
  bash:  createBashToolDefinition,
  edit:  createEditToolDefinition,
  write: createWriteToolDefinition,
  grep:  createGrepToolDefinition,
  find:  createFindToolDefinition,
  ls:    createLsToolDefinition,
} as Record<string, (cwd: string) => ToolDefinition<any, any, any>>;  // eslint-disable-line @typescript-eslint/no-explicit-any
const BUILTIN_NAMES = new Set(Object.keys(BUILTIN_FACTORIES));

export class ToolRegistry {
  /**
   * Execute functions for extension tools captured via registerTool intercept.
   * Built-ins are NOT stored here — they're resolved via BUILTIN_FACTORIES.
   */
  private extensionTools = new Map<string, ExecuteFn>();

  /**
   * Cache of built-in ToolDefinitions keyed by `${cwd}:${toolName}`.
   * Avoids recreating closures on each of up to 100 dispatch() calls/execution.
   *
   * Size: bounded by (unique cwds in session) × 7 built-ins. In practice
   * sessions rarely span more than a handful of cwds, so this stays small.
   */
  private builtinCache = new Map<string, ToolDefinition<any, any, any>>();  // eslint-disable-line @typescript-eslint/no-explicit-any

  constructor(pi: ExtensionAPI) {
    this.installRegisterToolIntercept(pi);
  }

  /**
   * Intercept pi.registerTool() to capture execute functions for extension tools.
   * Calls through to the original immediately — pi's tool registration is unaffected.
   *
   * TODO(upstream): remove this intercept when pi exposes
   * pi.executeTool(name, params, ctx): Promise<AgentToolResult>. The dispatch()
   * signature already mirrors that future API.
   */
  private installRegisterToolIntercept(pi: ExtensionAPI): void {
    const original = (pi.registerTool as Function).bind(pi);

    (pi as unknown as { registerTool: Function }).registerTool = (tool: {
      name: string;
      execute: ExecuteFn;
      [key: string]: unknown;
    }) => {
      if (!BLOCKED_TOOLS.has(tool.name) && !BUILTIN_NAMES.has(tool.name)) {
        this.extensionTools.set(tool.name, tool.execute);
      }
      return original(tool);
    };

    // Verify the patch landed — pi could seal its API object in a future version.
    if ((pi as unknown as { registerTool: unknown }).registerTool === original) {
      console.warn("[ptc] registerTool intercept failed — extension tools will be unavailable in PTC");
    }
  }

  /**
   * Returns the tools available inside PTC: built-ins always, extension tools
   * only if their execute was captured via the intercept (i.e. loaded after ptc).
   */
  getAvailableTools(pi: ExtensionAPI): ToolInfo[] {
    const allTools = pi.getAllTools();
    const unavailable: string[] = [];

    const available = allTools.filter((t) => {
      if (BLOCKED_TOOLS.has(t.name)) return false;
      if (BUILTIN_NAMES.has(t.name)) return true;
      if (this.extensionTools.has(t.name)) return true;
      unavailable.push(t.name);
      return false;
    });

    if (unavailable.length > 0) {
      console.warn(
        `[ptc] The following tools are unavailable inside PTC because their extensions loaded ` +
          `before ptc in the extension list: ${unavailable.join(", ")}. ` +
          `To fix, move ptc earlier in your extension load order.`,
      );
    }

    return available;
  }

  /**
   * Dispatch a tool call and return its concatenated text output.
   * Single path for built-ins and extension tools — both use the 5-arg execute() signature.
   */
  async dispatch(
    toolName: string,
    params: Record<string, unknown>,
    cwd: string,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<string> {
    const toolCallId = `ptc_${generateId()}`;
    let result: AgentToolResult<unknown>;

    if (BUILTIN_NAMES.has(toolName)) {
      const cacheKey = `${cwd}:${toolName}`;
      let def = this.builtinCache.get(cacheKey);
      if (!def) {
        const factory = BUILTIN_FACTORIES[toolName];
        def = factory(cwd);
        this.builtinCache.set(cacheKey, def);
      }
      result = await def.execute(toolCallId, params as any, signal, undefined, ctx);
    } else {
      const execute = this.extensionTools.get(toolName);
      if (!execute) {
        throw new Error(
          `[ptc] Tool "${toolName}" is not available. ` +
            `It may be blocked or loaded before the ptc extension.`,
        );
      }
      result = await execute(toolCallId, params, signal, undefined, ctx);
    }

    return extractText(result);
  }
}

/** Extract concatenated text from a tool result content array. */
function extractText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
