/**
 * @module ptc/tool-registry
 * @purpose Manages access to tool execute functions for PTC dispatch.
 *
 * ## Strategy
 *
 * pi's ExtensionAPI.getAllTools() returns metadata only (name, description,
 * parameters) — no execute functions. To actually call tools from PTC, we need
 * two sources:
 *
 * 1. Built-in tools (read, bash, edit, write, grep, find, ls):
 *    Use createXxxToolDefinition(cwd) from @mariozechner/pi-coding-agent 0.62.0+.
 *    These return ToolDefinition with the full 5-arg execute() signature.
 *
 * 2. Extension tools (dev-tools, bus, notes, proxmox, etc.):
 *    Intercept pi.registerTool() at load time to capture execute functions.
 *    This is the only viable approach until pi exposes pi.executeTool() upstream.
 *
 * ## Long-term path
 *
 * When pi adds `pi.executeTool(name, params, ctx): Promise<AgentToolResult>` to
 * ExtensionAPI, the intercept in installRegisterToolIntercept() can be removed.
 * The dispatch() method signature already mirrors that future API. Swap the
 * implementation bodies and delete the extensionTools map.
 *
 * ## Load order note
 *
 * The intercept is installed when ToolRegistry is constructed. Extensions that
 * load BEFORE ptc register their tools before the intercept is installed, so
 * their execute functions won't be captured. At dispatch time, unknown extension
 * tools (not built-ins, not captured) are excluded from the wrapper list and
 * result in a clear error message.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  AgentToolResult,
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

const BUILTIN_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export class ToolRegistry {
  /**
   * Execute functions for extension tools captured via registerTool intercept.
   * Built-ins are NOT stored here — they're created via factory functions.
   */
  private extensionTools = new Map<string, ExecuteFn>();

  /**
   * Cache of built-in ToolDefinitions keyed by `${cwd}:${toolName}`.
   * Factory functions are cheap closures but get called up to 100 times/execution,
   * so we cache to avoid redundant object creation.
   */
  private builtinCache = new Map<string, NonNullable<ReturnType<typeof createBuiltinDefinition>>>();

  constructor(pi: ExtensionAPI) {
    this.installRegisterToolIntercept(pi);
  }

  /**
   * Intercept pi.registerTool() to capture execute functions for extension tools.
   *
   * This is a targeted intercept: we call-through to the original immediately,
   * so pi's normal tool registration is unaffected. We only store the execute
   * function reference for later use in dispatch().
   */
  private installRegisterToolIntercept(pi: ExtensionAPI): void {
    const original = (pi.registerTool as Function).bind(pi);

    (pi as unknown as { registerTool: Function }).registerTool = (tool: {
      name: string;
      execute: ExecuteFn;
      [key: string]: unknown;
    }) => {
      // Capture execute for non-blocked, non-builtin tools
      if (!BLOCKED_TOOLS.has(tool.name) && !BUILTIN_NAMES.has(tool.name)) {
        this.extensionTools.set(tool.name, tool.execute);
      }
      return original(tool);
    };
  }

  /**
   * Get the list of tools available inside PTC.
   * Used by wrapper-gen to generate function stubs and by index.ts for the description.
   *
   * A tool is available if:
   *   - It's a built-in (always available)
   *   - It's an extension tool whose execute was captured via the intercept
   */
  getAvailableTools(pi: ExtensionAPI): ToolInfo[] {
    const allTools = pi.getAllTools();
    const unavailable: string[] = [];

    const available = allTools.filter((t) => {
      if (BLOCKED_TOOLS.has(t.name)) return false;
      if (BUILTIN_NAMES.has(t.name)) return true;
      if (this.extensionTools.has(t.name)) return true;
      // Extension tool that loaded before ptc — log once
      unavailable.push(t.name);
      return false;
    });

    if (unavailable.length > 0) {
      console.warn(
        `[ptc] The following tools are unavailable in PTC (loaded before ptc extension): ${unavailable.join(", ")}`,
      );
    }

    return available;
  }

  /**
   * Dispatch a tool call by name and return its text output.
   *
   * This is the single dispatch path for all tool types (built-in + extension).
   * Both use the same 5-arg ToolDefinition.execute() signature as of pi 0.62.0.
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
        const created = createBuiltinDefinition(toolName, cwd);
        if (!created) throw new Error(`[ptc] Unknown built-in tool: ${toolName}`);
        this.builtinCache.set(cacheKey, created);
        def = created;
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a ToolDefinition for a named built-in tool. */
function createBuiltinDefinition(name: string, cwd: string) {
  switch (name) {
    case "read":  return createReadToolDefinition(cwd);
    case "bash":  return createBashToolDefinition(cwd);
    case "edit":  return createEditToolDefinition(cwd);
    case "write": return createWriteToolDefinition(cwd);
    case "grep":  return createGrepToolDefinition(cwd);
    case "find":  return createFindToolDefinition(cwd);
    case "ls":    return createLsToolDefinition(cwd);
    default:      return null;
  }
}

/** Extract concatenated text from a tool result content array. */
function extractText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
