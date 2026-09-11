/**
 * @module ptc/subprocess-preamble
 * @purpose Provides the subprocess RPC client, tool namespace, and settle helper.
 */
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  MAX_TOOL_CALLS,
  PtcToolFailureClass,
  type PtcToolFailure,
  type PtcToolFailureClass as FailureClass,
  type RpcOutbound,
} from "./types";

interface RuntimeToolRecord {
  readonly name: string;
  readonly key: string;
}

interface RuntimeToolCatalog {
  readonly callable: readonly RuntimeToolRecord[];
  readonly unavailable: readonly RuntimeToolRecord[];
  readonly blocked: readonly RuntimeToolRecord[];
}

export type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PtcToolFailure };

const __pending = new Map<
  string,
  { resolve: (value: string) => void; reject: (error: Error) => void }
>();
let __callId = 0;
let __toolCalls = 0;
const __nonToolProperties = new Set([
  "then",
  "toJSON",
  "toString",
  "valueOf",
  "constructor",
  "inspect",
]);

class PtcToolCallError extends Error {
  readonly failure: PtcToolFailure;

  constructor(failure: PtcToolFailure) {
    super(failure.message);
    this.name = "PtcToolCallError";
    this.failure = failure;
  }
}

function __rpc_send(message: Extract<RpcOutbound, { type: "tool_call" }>): void {
  writeFileSync(3, JSON.stringify(message) + "\n");
}

const __rl = createInterface({ input: process.stdin, terminal: false });
__rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed) as {
      type: string;
      id: string;
      result?: string;
      failure?: PtcToolFailure;
    };
    const pending = __pending.get(msg.id);
    if (!pending) return;
    __pending.delete(msg.id);
    if (msg.type === "tool_result") {
      pending.resolve(msg.result ?? "");
    } else {
      pending.reject(new PtcToolCallError(normalizeFailure(msg.failure)));
    }
  } catch {
    // Ignore input that is not a parent RPC response.
  }
});

function normalizeFailure(failure: PtcToolFailure | undefined): PtcToolFailure {
  if (
    failure &&
    typeof failure.class === "string" &&
    typeof failure.message === "string" &&
    (failure.tool === undefined || typeof failure.tool === "string")
  ) {
    return failure;
  }
  return {
    class: PtcToolFailureClass.Nested,
    message: "PTC received an invalid nested tool failure.",
  };
}

export async function __rpc_call(
  tool: string,
  params: Record<string, unknown> = {},
): Promise<string> {
  if (++__toolCalls > MAX_TOOL_CALLS) {
    throw new Error(`PTC: exceeded ${MAX_TOOL_CALLS} tool call limit`);
  }
  const id = `c_${__callId++}`;
  __rpc_send({ type: "tool_call", id, tool, params });
  return new Promise<string>((resolve, reject) => {
    __pending.set(id, { resolve, reject });
  });
}

function accessFailure(
  failureClass: FailureClass,
  tool: string,
  message: string,
): () => Promise<never> {
  return async () => {
    throw new PtcToolCallError({ class: failureClass, tool, message });
  };
}

function addTool(
  target: Record<string, (params?: Record<string, unknown>) => Promise<string>>,
  record: RuntimeToolRecord,
  callable: (params?: Record<string, unknown>) => Promise<string>,
): void {
  target[record.name] = callable;
  target[record.key] ??= callable;
}

export function __create_tools(
  catalog: RuntimeToolCatalog,
): Record<string, (params?: Record<string, unknown>) => Promise<string>> {
  const target: Record<string, (params?: Record<string, unknown>) => Promise<string>> =
    Object.create(null) as Record<
      string,
      (params?: Record<string, unknown>) => Promise<string>
    >;

  for (const record of catalog.callable) {
    addTool(target, record, (params = {}) => __rpc_call(record.name, params));
  }
  for (const record of catalog.unavailable) {
    addTool(
      target,
      record,
      accessFailure(
        PtcToolFailureClass.Unavailable,
        record.name,
        `PTC unavailable tool "${record.name}". It has no PTC dispatcher. Call it directly.`,
      ),
    );
  }
  for (const record of catalog.blocked) {
    addTool(
      target,
      record,
      accessFailure(
        PtcToolFailureClass.Blocked,
        record.name,
        `PTC blocked tool "${record.name}". Call it directly, not inside PTC.`,
      ),
    );
  }

  return new Proxy(target, {
    get(current, property) {
      if (typeof property !== "string") return undefined;
      if (Object.hasOwn(current, property)) return current[property];
      if (__nonToolProperties.has(property)) return undefined;
      return accessFailure(
        PtcToolFailureClass.Unknown,
        property,
        `PTC unknown tool "${property}". Call PTC with action="inspect" to view current tools.`,
      );
    },
  });
}

function settledFailure(cause: unknown): PtcToolFailure {
  if (cause instanceof PtcToolCallError) return cause.failure;
  return {
    class: PtcToolFailureClass.UserScript,
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

export async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (cause) {
    return { ok: false, error: settledFailure(cause) };
  }
}
