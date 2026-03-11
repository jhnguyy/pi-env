/**
 * Shared types, interfaces, constants, and error class for the agent-bus extension.
 * This is the "dictionary" for the entire extension — start here.
 */

import { BaseExtensionError } from "../_shared/errors";

// ─── Message Format ───────────────────────────────────────────

export type MessageType = "status" | "result" | "error" | "command";

export interface BusMessage {
  channel: string;
  sender: string;
  timestamp: number;
  type: MessageType;
  message: string;
  data?: Record<string, unknown>;
}

// ─── Cursor Format ────────────────────────────────────────────

/** Maps channel name → timestamp of last read message (exclusive — messages > this are new) */
export type CursorRecord = Record<string, number>;

// ─── Tool Input (discriminated union) ─────────────────────────

export interface BusStartInput {
  action: "start";
  session?: string;
  agentId?: string;
}

export interface BusPublishInput {
  action: "publish";
  channel: string;
  message: string;
  type?: MessageType;
  data?: Record<string, unknown>;
}

export interface BusSubscribeInput {
  action: "subscribe";
  channels: string[];
}

export interface BusCheckInput {
  action: "check";
}

export interface BusReadInput {
  action: "read";
  channel: string;
}

export interface BusWaitInput {
  action: "wait";
  channels: string[];
  timeout?: number; // seconds, default 300
}

export type BusInput =
  | BusStartInput
  | BusPublishInput
  | BusSubscribeInput
  | BusCheckInput
  | BusReadInput
  | BusWaitInput;

// ─── Config ──────────────────────────────────────────────────

export interface BusConfig {
  sessionId: string | null; // null until bus start
  agentId: string | null;   // from PI_AGENT_ID env var
}

// ─── Channel Validation ───────────────────────────────────────

export const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9:_-]*$/;
export const CHANNEL_MAX_LEN = 64;

// ─── Errors ──────────────────────────────────────────────────

export type BusErrorCode =
  | "NO_AGENT_ID"
  | "BUS_NOT_STARTED"
  | "SESSION_CONFLICT"
  | "INVALID_CHANNEL"
  | "FS_ERROR";

export class BusError extends BaseExtensionError<BusErrorCode> {}
