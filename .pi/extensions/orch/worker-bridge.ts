/**
 * worker-bridge — Standalone pi extension for orchestrated worker processes.
 *
 * Loaded via `-e` in worker pi processes spawned by orch. Bridges the message
 * bus to the live pi session so the orchestrator can inject follow-up messages
 * into running workers.
 *
 * Guard: if PI_AGENT_ID or PI_BUS_SESSION are absent, all setup is skipped.
 * This makes the extension safe to load in non-worker contexts.
 *
 * Responsibilities:
 *   - Poll worker inbox channel every 2s, inject messages via sendUserMessage
 *   - Respect idle vs streaming state (deliverAs: "followUp" when streaming)
 *   - Handle shutdown commands from the orchestrator
 *   - Register `worker_exit` tool for clean task completion
 *   - Clear poll interval on session_shutdown
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { initBusService } from "../agent-bus/bus-service";

export default function (pi: ExtensionAPI) {
  const agentId = process.env.PI_AGENT_ID;
  const busSession = process.env.PI_BUS_SESSION;

  // Guard: only activate in worker context
  if (!agentId || !busSession) return;

  const inboxChannel = `worker:${agentId}:inbox`;

  // ─── State tracking ───────────────────────────────────────────

  let isStreaming = false;
  let cachedCtx: ExtensionContext | null = null;

  pi.on("agent_start", async () => {
    isStreaming = true;
  });

  pi.on("agent_end", async (_event, ctx) => {
    isStreaming = false;
    cachedCtx = ctx;
  });

  // ─── Background polling ───────────────────────────────────────

  const { client } = initBusService();

  const pollInterval = setInterval(async () => {
    try {
      const messages = client.read(inboxChannel);

      for (const msg of messages) {
        if (msg.data?.command === "shutdown") {
          // Use cachedCtx if available; fall back to pi.shutdown via tool
          if (cachedCtx) {
            cachedCtx.shutdown();
          }
        } else {
          if (isStreaming) {
            pi.sendUserMessage(msg.message, { deliverAs: "followUp" });
          } else {
            pi.sendUserMessage(msg.message);
          }
        }
      }
    } catch {
      // Bus may not yet be initialized — silently skip until it is
    }
  }, 2000);

  // ─── worker_exit tool ─────────────────────────────────────────

  pi.registerTool({
    name: "worker_exit",
    label: "Worker Exit",
    description:
      "Signal that your task is complete and exit cleanly. Call this after writing your result file.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutdown requested. Exiting after this response." }],
        details: {},
      };
    },
  });

  // ─── Cleanup on shutdown ──────────────────────────────────────

  pi.on("session_shutdown", async () => {
    clearInterval(pollInterval);
  });
}
