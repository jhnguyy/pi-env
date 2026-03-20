/**
 * BusClient — business logic for all bus operations.
 *
 * Stateless design: agent ID from env, session ID from env or bus start,
 * subscriptions from cursor file on disk. No session reconstruction needed.
 */

import { generateId } from "../_shared/id";
import type { BusTransport } from "./transport";
import type { BusConfig, BusMessage, CursorRecord, MessageType } from "./types";
import { BusError, CHANNEL_MAX_LEN, CHANNEL_PATTERN } from "./types";

const POLL_MS = 200;

export class BusClient {
  constructor(
    private transport: BusTransport,
    private config: BusConfig
  ) {}

  // ─── Helpers ─────────────────────────────────────────────────

  private getAgentId(): string {
    const id = this.config.agentId ?? process.env.PI_AGENT_ID ?? null;
    if (!id) {
      throw new BusError("No agent ID — set PI_AGENT_ID env var", "NO_AGENT_ID");
    }
    return id;
  }

  private getSessionId(): string {
    const id = this.config.sessionId ?? process.env.PI_BUS_SESSION ?? null;
    if (!id) {
      throw new BusError("Bus not initialized — call bus start", "BUS_NOT_STARTED");
    }
    if (!this.transport.sessionExists(id)) {
      throw new BusError("Bus not initialized — call bus start", "BUS_NOT_STARTED");
    }
    return id;
  }

  private validateChannel(channel: string): void {
    if (!CHANNEL_PATTERN.test(channel) || channel.length > CHANNEL_MAX_LEN) {
      throw new BusError(
        `Invalid channel "${channel}" — use a-z, 0-9, hyphens, colons`,
        "INVALID_CHANNEL"
      );
    }
  }

  private formatTime(ts: number): string {
    return new Date(ts).toTimeString().slice(0, 8); // HH:MM:SS
  }

  // ─── start ───────────────────────────────────────────────────

  /**
   * Create bus session. Generate session ID if not provided.
   * Idempotent for same session; errors if different session already active.
   * Sets process.env.PI_BUS_SESSION (and PI_AGENT_ID if agentIdParam provided).
   */
  start(sessionParam?: string, agentIdParam?: string): string {
    const existingId =
      this.config.sessionId ?? process.env.PI_BUS_SESSION ?? null;

    if (sessionParam && existingId && existingId !== sessionParam) {
      throw new BusError(
        `Bus already active on session "${existingId}" — cannot start different session`,
        "SESSION_CONFLICT"
      );
    }

    const sessionId =
      sessionParam ?? existingId ?? generateId(3);

    this.transport.ensureSession(sessionId);
    this.config.sessionId = sessionId;
    process.env.PI_BUS_SESSION = sessionId;

    // Set agent ID on demand — mirrors PI_BUS_SESSION side-effect pattern
    if (agentIdParam) {
      this.config.agentId = agentIdParam;
      process.env.PI_AGENT_ID = agentIdParam;
    }

    return sessionId;
  }

  // ─── publish ─────────────────────────────────────────────────

  /** Write a message to a channel. No subscription required. */
  publish(
    channel: string,
    message: string,
    type?: MessageType,
    data?: Record<string, unknown>
  ): void {
    this.validateChannel(channel);
    const agentId = this.getAgentId();
    const sessionId = this.getSessionId();

    const msg: BusMessage = {
      channel,
      sender: agentId,
      timestamp: Date.now(),
      type: type ?? "status",
      message,
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
    };

    this.transport.publish(sessionId, channel, msg);
  }

  // ─── subscribe ───────────────────────────────────────────────

  /**
   * Register channels for context hook notifications.
   * Sets cursor to now for new channels (skips old messages).
   * Additive — existing channel cursors are not reset.
   */
  subscribe(channels: string[]): string[] {
    for (const ch of channels) this.validateChannel(ch);
    const agentId = this.getAgentId();
    const sessionId = this.getSessionId();

    const cursor = this.transport.readCursor(sessionId, agentId);
    // Use now-1 so messages published at this exact millisecond are included
    // (readMessages uses strict >, so cursor=now would miss same-ms publishes)
    const since = Date.now() - 1;
    const updates: CursorRecord = {};

    for (const ch of channels) {
      if (!(ch in cursor)) {
        updates[ch] = since;
      }
    }

    if (Object.keys(updates).length > 0) {
      this.transport.updateCursor(sessionId, agentId, updates);
    }

    return channels;
  }

  // ─── check ───────────────────────────────────────────────────

  /**
   * Non-blocking. Count new messages on all subscribed channels.
   * Returns { channel: count } for channels with new messages.
   */
  check(): Record<string, number> {
    const agentId = this.getAgentId();
    const sessionId = this.getSessionId();

    const cursor = this.transport.readCursor(sessionId, agentId);
    const result: Record<string, number> = {};

    for (const [channel, since] of Object.entries(cursor)) {
      const count = this.transport.countMessages(sessionId, channel, since);
      if (count > 0) result[channel] = count;
    }

    return result;
  }

  // ─── read ────────────────────────────────────────────────────

  /**
   * Read all messages since cursor, advance cursor.
   * Implicitly subscribes (cursor = 0) to see all historical messages.
   */
  read(channel: string): BusMessage[] {
    this.validateChannel(channel);
    const agentId = this.getAgentId();
    const sessionId = this.getSessionId();

    const cursor = this.transport.readCursor(sessionId, agentId);

    // Implicit subscribe at 0 — read all existing messages
    if (!(channel in cursor)) {
      this.transport.updateCursor(sessionId, agentId, { [channel]: 0 });
      cursor[channel] = 0;
    }

    const since = cursor[channel];
    const messages = this.transport.readMessages(sessionId, channel, since);

    if (messages.length > 0) {
      const maxTs = Math.max(...messages.map((m) => m.timestamp));
      this.transport.updateCursor(sessionId, agentId, { [channel]: maxTs });
    }

    return messages;
  }

  // ─── wait ────────────────────────────────────────────────────

  /**
   * Block until new messages arrive on any listed channel.
   * Polls at 200ms intervals. Implicitly subscribes (cursor = now) for new channels.
   * Respects AbortSignal for cancellation.
   */
  async wait(
    channels: string[],
    timeoutSecs: number = 300,
    signal?: AbortSignal
  ): Promise<{ messages: BusMessage[]; timedOut: boolean }> {
    for (const ch of channels) this.validateChannel(ch);
    const agentId = this.getAgentId();
    const sessionId = this.getSessionId();

    // Read cursor, implicitly subscribe new channels at "now - 1"
    // (strict > comparison means same-ms publishes would be missed at exact "now")
    const cursor = this.transport.readCursor(sessionId, agentId);
    const since = Date.now() - 1;
    const newChannelUpdates: CursorRecord = {};

    for (const ch of channels) {
      if (!(ch in cursor)) {
        cursor[ch] = since; // update in-memory
        newChannelUpdates[ch] = since;
      }
    }

    if (Object.keys(newChannelUpdates).length > 0) {
      this.transport.updateCursor(sessionId, agentId, newChannelUpdates);
    }

    // Snapshot baseline cursor positions for the channels we're waiting on
    const baseline: CursorRecord = {};
    for (const ch of channels) {
      baseline[ch] = cursor[ch] ?? 0;
    }

    const deadline = Date.now() + timeoutSecs * 1000;

    while (true) {
      if (signal?.aborted) return { messages: [], timedOut: true };
      if (Date.now() >= deadline) return { messages: [], timedOut: true };

      // Poll all channels against baseline
      const allMessages: BusMessage[] = [];
      for (const ch of channels) {
        const msgs = this.transport.readMessages(sessionId, ch, baseline[ch]);
        allMessages.push(...msgs);
      }

      if (allMessages.length > 0) {
        // Advance cursor for each channel that had messages
        const cursorUpdates: CursorRecord = {};
        for (const ch of channels) {
          const chMsgs = allMessages.filter((m) => m.channel === ch);
          if (chMsgs.length > 0) {
            cursorUpdates[ch] = Math.max(...chMsgs.map((m) => m.timestamp));
          }
        }
        this.transport.updateCursor(sessionId, agentId, cursorUpdates);
        allMessages.sort((a, b) => a.timestamp - b.timestamp);
        return { messages: allMessages, timedOut: false };
      }

      // Sleep 200ms, wake early on abort
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, POLL_MS);
        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true }
          );
        }
      });
    }
  }

  // ─── formatMessages ──────────────────────────────────────────

  /**
   * Format messages for LLM consumption.
   * Format: [sender HH:MM:SS] message {data}
   * Data shown as compact JSON only when non-empty.
   */
  formatMessages(messages: BusMessage[]): string {
    return messages
      .map((m) => {
        const time = this.formatTime(m.timestamp);
        let line = `[${m.sender} ${time}] ${m.message}`;
        if (m.data && Object.keys(m.data).length > 0) {
          line += ` ${JSON.stringify(m.data)}`;
        }
        return line;
      })
      .join("\n");
  }
}
