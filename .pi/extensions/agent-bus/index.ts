/**
 * Agent Bus Extension — entry point.
 *
 * Thin wiring only. Zero business logic. Provides inter-agent messaging via
 * filesystem-backed pub/sub with named channels.
 *
 * Headline feature: bus wait — event-driven blocking that replaces sleep-poll loops.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";

import { initBusService } from "./bus-service";
import { BusError } from "./types";
import { txt, ok, err } from "../_shared/result";

export default function (pi: ExtensionAPI) {
  // ─── Components (DI wiring) ─────────────────────────────────
  // Singleton: shared with orch so both extensions operate on the same
  // BusClient instance, cursor file, and session ID.
  const { client, transport } = initBusService();

  // ─── agent_end Hook: Auto-publish bus signal ─────────────────
  // When ORCH_BUS_CHANNEL is set (injected by orch spawn), publish a completion
  // message on that channel after the first agent_end. This allows orch wait to
  // receive the signal without the LLM needing to remember to publish.
  // Guard with hasPublished to avoid double-publish in multi-turn sessions.
  let hasPublished = false;

  pi.on("agent_end", async (_event, _ctx) => {
    if (hasPublished) return;
    const channel = process.env.ORCH_BUS_CHANNEL;
    if (!channel) return;
    hasPublished = true;
    try {
      client.publish(channel, "agent_end", "status", { signal: "agent_end" });
    } catch {
      // Best-effort — don't surface errors from signal delivery to the agent
    }
  });

  // ─── Context Hook: Passive Notification ─────────────────────
  // ~15 tokens when active, zero tokens when idle.
  pi.on("before_agent_start", async (_event, _ctx) => {
    // Zero-cost guard: bail fast when missing prerequisites
    const agentId = process.env.PI_AGENT_ID ?? null;
    const sessionId = process.env.PI_BUS_SESSION ?? null;
    if (!agentId || !sessionId) return {};
    if (!transport.sessionExists(sessionId)) return {};

    const cursor = transport.readCursor(sessionId, agentId);
    if (Object.keys(cursor).length === 0) return {};

    // Count new messages per subscribed channel
    const counts: Record<string, number> = {};
    let total = 0;
    for (const [ch, since] of Object.entries(cursor)) {
      const count = transport.countMessages(sessionId, ch, since);
      if (count > 0) {
        counts[ch] = count;
        total += count;
      }
    }

    if (total === 0) return {};

    const parts = Object.entries(counts)
      .map(([ch, n]) => `#${ch}(${n})`)
      .join(" ");
    const msg = `[bus] ${total} new: ${parts} — use bus check for details`;

    return {
      message: {
        customType: "agent-bus",
        content: msg,
        display: true,
      },
    };
  });

  // ─── bus Tool ───────────────────────────────────────────────
  pi.registerTool({
    name: "bus",
    label: "Bus",

    description: [
      "Inter-agent message bus. Publish/subscribe on named channels across pi processes.",
      "",
      "Actions:",
      "  start     — Initialize bus session. Optional: session, agentId. Sets PI_BUS_SESSION/PI_AGENT_ID. Idempotent.",
      "  publish   — Write message to channel. Required: channel, message. Optional: type, data.",
      "  subscribe — Register channels for notification. Required: channels. Additive, skips history.",
      "  check     — Non-blocking count of new messages on subscribed channels.",
      "  read      — Read all messages since cursor, advance cursor. Required: channel. Implicitly subscribes.",
      "  wait      — Block until new messages. Required: channels. Optional: timeout (default 300s). Returns triggering messages.",
      "",
      "Channel names: a-z, 0-9, hyphens, colons. Max 64 chars.",
      "Set PI_AGENT_ID env var or pass agentId to bus start to identify yourself on the bus.",
    ].join("\n"),

    // promptSnippet and promptGuidelines are valid at runtime but missing from local (outdated) types.
    // They are present in the global @mariozechner/pi-coding-agent type definitions.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    promptSnippet:
      "Inter-agent message bus. Publish/subscribe on named channels across pi processes.\n" +
      "Use bus wait for event-driven orchestration instead of sleep-poll loops.",

    // @ts-ignore
    promptGuidelines: [
      "Start orchestration with bus start { agentId: 'orch' }. Pass returned session ID as PI_BUS_SESSION env var when spawning agents.",
      "Workers publish; orchestrators wait/read. Channels: status, results, review, agent:<id>.",
    ],

    parameters: Type.Object({
      action: StringEnum(
        ["start", "publish", "subscribe", "check", "read", "wait"] as const,
        { description: "Operation to perform" }
      ),
      // --- start params ---
      session: Type.Optional(
        Type.String({ description: "Session ID to use or create (default: auto-generated)" })
      ),
      agentId: Type.Optional(
        Type.String({ description: "Agent ID for this process. Sets PI_AGENT_ID. Optional for start." })
      ),
      // --- publish / read params ---
      channel: Type.Optional(
        Type.String({ description: "Channel name (a-z, 0-9, hyphens, colons)" })
      ),
      // --- publish params ---
      message: Type.Optional(
        Type.String({ description: "Human-readable message content" })
      ),
      type: Type.Optional(
        StringEnum(["status", "result", "error", "command"] as const, {
          description: "Message type (default: status)",
        })
      ),
      data: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Structured payload for programmatic consumption",
        })
      ),
      // --- subscribe / wait params ---
      channels: Type.Optional(
        Type.Array(Type.String(), {
          description: "Channel names to subscribe to or wait on",
        })
      ),
      // --- wait params ---
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in seconds (default: 300)" })
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      try {
        switch (params.action) {
          case "start": {
            const sessionId = client.start(params.session, params.agentId);
            const agentId = process.env.PI_AGENT_ID;
            const out = agentId
              ? `Session: ${sessionId}\nAgent: ${agentId}`
              : `Session: ${sessionId}`;
            return ok(out);
          }

          case "publish": {
            if (!params.channel || !params.message) {
              return err("publish requires channel and message");
            }
            client.publish(
              params.channel,
              params.message,
              params.type,
              params.data as Record<string, unknown> | undefined
            );
            return ok(`Published to #${params.channel}`);
          }

          case "subscribe": {
            if (!params.channels || params.channels.length === 0) {
              return err("subscribe requires channels array");
            }
            client.subscribe(params.channels);
            const list = params.channels.map((ch) => `#${ch}`).join(", ");
            return ok(`Subscribed: ${list}`);
          }

          case "check": {
            const counts = client.check();
            if (Object.keys(counts).length === 0) {
              return ok("No new messages");
            }
            const parts = Object.entries(counts)
              .map(([ch, n]) => `#${ch}(${n})`)
              .join(" ");
            return ok(parts);
          }

          case "read": {
            if (!params.channel) {
              return err("read requires channel");
            }
            const messages = client.read(params.channel);
            if (messages.length === 0) {
              return ok("No messages");
            }
            return ok(client.formatMessages(messages));
          }

          case "wait": {
            if (!params.channels || params.channels.length === 0) {
              return err("wait requires channels array");
            }
            const timeoutSecs = params.timeout ?? 300;
            const { messages, timedOut } = await client.wait(
              params.channels,
              timeoutSecs,
              signal ?? undefined
            );
            if (timedOut) {
              const list = params.channels.map((ch) => `#${ch}`).join(", ");
              return ok(`Timeout (${timeoutSecs}s) — no messages on ${list}`);
            }
            return ok(client.formatMessages(messages));
          }

          default:
            return err(`Unknown action: ${(params as { action: string }).action}`);
        }
      } catch (e) {
        const msg =
          e instanceof BusError ? e.message : `unexpected error: ${e}`;
        return err(msg);
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("bus"));
      text += " " + theme.fg("accent", args.action ?? "");
      if (args.channel) text += " " + theme.fg("muted", `#${args.channel}`);
      if (args.channels && args.channels.length > 0) {
        text += " " + theme.fg("muted", args.channels.map((ch) => `#${ch}`).join(", "));
      }
      if (args.session) text += " " + theme.fg("dim", args.session);
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      const isError =
        result.details != null &&
        typeof result.details === "object" &&
        "error" in result.details;
      if (isError) {
        return new Text(theme.fg("error", text || "error"), 0, 0);
      }
      return new Text(theme.fg("success", "✓ " + text), 0, 0);
    },
  });
}

// ─── Helpers ────────────────────────────────────────────────
// txt / ok / err imported from ../_shared/result
