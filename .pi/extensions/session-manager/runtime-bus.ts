import { randomUUID } from "node:crypto";
import { chmod, lstat, rename, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { Data, Effect, Schema } from "effect";
import type { RuntimePaths } from "./runtime-path.js";

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_BUFFER_BYTES = MAX_FRAME_BYTES + 1;
const MAX_CONNECTIONS = 32;
const MAX_IN_FLIGHT = 8;
const MAX_DEADLINE_AHEAD_MS = 60_000;
const IDLE_TIMEOUT_MS = 15_000;

export const RuntimeMethod = {
  Ping: "ping",
  Reconcile: "reconcile",
  PublishReady: "publish-ready",
} as const;
export type RuntimeMethod = (typeof RuntimeMethod)[keyof typeof RuntimeMethod];

export type ReadyPublication = {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly launchId: string;
  readonly windowId: string;
};
export type RestoreOutcome = {
  readonly sessionId: string;
  readonly name?: string;
  readonly state: "restored" | "active" | "timed-out" | "failed";
  readonly reason?: string;
};
export type RestoreSummary = {
  readonly outcomes: readonly RestoreOutcome[];
};
type RuntimeRequestBase = {
  readonly version: 1;
  readonly type: "request";
  readonly workspaceId: string;
  readonly coordinatorSessionId: string;
  readonly requestId: string;
  readonly deadline: number;
};
export type RuntimeRequest =
  | (RuntimeRequestBase & {
      readonly method: "ping";
      readonly params: Readonly<Record<string, never>>;
    })
  | (RuntimeRequestBase & {
      readonly method: "reconcile";
      readonly idempotencyKey: string;
      readonly params: Readonly<Record<string, never>>;
    })
  | (RuntimeRequestBase & {
      readonly method: "publish-ready";
      readonly idempotencyKey: string;
      readonly params: ReadyPublication;
    });
export type RuntimeResponse =
  | {
      readonly version: 1;
      readonly type: "response";
      readonly requestId: string;
      readonly coordinatorRuntimeId: string;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly version: 1;
      readonly type: "response";
      readonly requestId: string;
      readonly coordinatorRuntimeId: string;
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export type RuntimeResultByMethod = {
  readonly ping: { readonly alive: true };
  readonly reconcile: RestoreSummary;
  readonly "publish-ready": { readonly accepted: true };
};

export class RuntimeBusFailure extends Data.TaggedError("RuntimeBusFailure")<{
  operation: string;
  reason: string;
}> {}

const requestSchema = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("request"),
  workspaceId: Schema.String,
  coordinatorSessionId: Schema.String,
  requestId: Schema.String,
  deadline: Schema.Number,
  method: Schema.Literals(["ping", "reconcile", "publish-ready"]),
  idempotencyKey: Schema.optionalKey(Schema.String),
  params: Schema.Unknown,
});
const responseSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("response"),
    requestId: Schema.String,
    coordinatorRuntimeId: Schema.String,
    ok: Schema.Literal(true),
    result: Schema.Unknown,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("response"),
    requestId: Schema.String,
    coordinatorRuntimeId: Schema.String,
    ok: Schema.Literal(false),
    error: Schema.Struct({ code: Schema.String, message: Schema.String }),
  }),
]);
const readyPublicationSchema = Schema.Struct({
  sessionId: Schema.String,
  runtimeId: Schema.String,
  launchId: Schema.String,
  windowId: Schema.String,
});
const restoreSummarySchema = Schema.Struct({
  outcomes: Schema.Array(
    Schema.Struct({
      sessionId: Schema.String,
      name: Schema.optionalKey(Schema.String),
      state: Schema.Literals(["restored", "active", "timed-out", "failed"]),
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
});
const decodeRequest = Schema.decodeUnknownSync(requestSchema, { onExcessProperty: "error" });
const decodeResponse = Schema.decodeUnknownSync(responseSchema, { onExcessProperty: "error" });
const decodeReadyPublication = Schema.decodeUnknownSync(readyPublicationSchema, {
  onExcessProperty: "error",
});
const decodeRestoreSummary = Schema.decodeUnknownSync(restoreSummarySchema, {
  onExcessProperty: "error",
});
const decodePingResult = Schema.decodeUnknownSync(Schema.Struct({ alive: Schema.Literal(true) }), {
  onExcessProperty: "error",
});
const decodePublishReadyResult = Schema.decodeUnknownSync(
  Schema.Struct({ accepted: Schema.Literal(true) }),
  { onExcessProperty: "error" },
);

const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const safeText = (value: unknown, maximum: number): value is string =>
  typeof value === "string" &&
  Buffer.byteLength(value, "utf8") > 0 &&
  Buffer.byteLength(value, "utf8") <= maximum &&
  !/[\0\r\n]/.test(value);

function parseReadyPublication(value: unknown): ReadyPublication {
  const publication = decodeReadyPublication(value);
  if (
    !safeText(publication.sessionId, 256) ||
    !safeText(publication.runtimeId, 256) ||
    !safeText(publication.launchId, 256) ||
    !safeText(publication.windowId, 256)
  ) {
    throw new Error("invalid readiness publication");
  }
  return publication;
}

function parseEmptyParams(value: unknown): Readonly<Record<string, never>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 0
  ) {
    throw new Error("method parameters must be an empty object");
  }
  return {};
}

function parseRequest(value: unknown): RuntimeRequest {
  const request = decodeRequest(value);
  if (!/^[0-9a-f]{64}$/.test(request.workspaceId)) throw new Error("invalid workspace ID");
  if (!safeText(request.coordinatorSessionId, 256) || !uuid(request.requestId)) {
    throw new Error("invalid request identity");
  }
  const base = {
    version: request.version,
    type: request.type,
    workspaceId: request.workspaceId,
    coordinatorSessionId: request.coordinatorSessionId,
    requestId: request.requestId,
    deadline: request.deadline,
  } as const;
  if (request.method === RuntimeMethod.Ping) {
    if (request.idempotencyKey !== undefined) throw new Error("ping does not accept idempotency");
    return { ...base, method: RuntimeMethod.Ping, params: parseEmptyParams(request.params) };
  }
  if (!safeText(request.idempotencyKey, 256)) {
    throw new Error("mutating request requires a valid idempotency key");
  }
  if (request.method === RuntimeMethod.PublishReady) {
    return {
      ...base,
      method: RuntimeMethod.PublishReady,
      idempotencyKey: request.idempotencyKey,
      params: parseReadyPublication(request.params),
    };
  }
  return {
    ...base,
    method: RuntimeMethod.Reconcile,
    idempotencyKey: request.idempotencyKey,
    params: parseEmptyParams(request.params),
  };
}

function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Buffer.from(message, "utf8").subarray(0, 2048).toString("utf8");
}

function writeFrame(socket: Socket, value: unknown): Promise<void> {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame, "utf8") - 1 > MAX_FRAME_BYTES) {
    return Promise.reject(new Error("response frame exceeds 64 KiB"));
  }
  return new Promise((resolve, reject) => {
    socket.write(frame, (error) => (error ? reject(error) : resolve()));
  });
}

type RequestCache = Map<string, { digest: string; expiresAt: number; promise: Promise<unknown> }>;

async function executeRequest(
  request: RuntimeRequest,
  handlers: RuntimeBusHandlers,
): Promise<unknown> {
  switch (request.method) {
    case RuntimeMethod.Ping:
      return { alive: true };
    case RuntimeMethod.Reconcile:
      return handlers.reconcile();
    case RuntimeMethod.PublishReady:
      await handlers.publishReady(request.params);
      return { accepted: true };
  }
}

function invokeRequest(
  request: RuntimeRequest,
  handlers: RuntimeBusHandlers,
  cache: RequestCache,
  now: number,
): Promise<unknown> {
  if (request.method === RuntimeMethod.Ping) return executeRequest(request, handlers);
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
  const idempotencyKey = request.idempotencyKey;
  const digest = JSON.stringify({ method: request.method, params: request.params });
  const existing = cache.get(idempotencyKey);
  if (existing?.digest !== undefined && existing.digest !== digest) {
    throw new Error("IdempotencyConflict");
  }
  if (existing) return existing.promise;
  const promise = executeRequest(request, handlers);
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(idempotencyKey, { digest, expiresAt: now + 600_000, promise });
  return promise;
}

export type RuntimeBusHandlers = {
  readonly reconcile: () => Promise<RestoreSummary>;
  readonly publishReady: (publication: ReadyPublication) => Promise<void>;
};

export type RuntimeBusServer = {
  readonly runtimeId: string;
  readonly close: () => Promise<void>;
};

export function startRuntimeBus(options: {
  readonly paths: RuntimePaths;
  readonly workspaceId: string;
  readonly coordinatorSessionId: string;
  readonly handlers: RuntimeBusHandlers;
  readonly uid?: number;
}): Effect.Effect<RuntimeBusServer, RuntimeBusFailure> {
  return Effect.tryPromise({
    try: async () => {
      const uid = options.uid ?? process.getuid?.();
      if (uid === undefined) throw new Error("user ID is unavailable");
      const runtimeId = randomUUID();
      let connections = 0;
      const cache: RequestCache = new Map();
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        if (++connections > MAX_CONNECTIONS) {
          sockets.delete(socket);
          socket.destroy();
          connections -= 1;
          return;
        }
        socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
        let buffer = Buffer.alloc(0);
        let inFlight = 0;
        let closed = false;
        const protocolError = async (requestId: string, code: string, message: string) => {
          if (closed) return;
          closed = true;
          await writeFrame(socket, {
            version: 1,
            type: "response",
            requestId,
            coordinatorRuntimeId: runtimeId,
            ok: false,
            error: { code, message },
          } satisfies RuntimeResponse).catch(() => undefined);
          socket.end();
        };
        const acceptRequest = (request: RuntimeRequest): boolean => {
          if (
            request.workspaceId !== options.workspaceId ||
            request.coordinatorSessionId !== options.coordinatorSessionId
          ) {
            void protocolError(
              request.requestId,
              "IdentityMismatch",
              "workspace or coordinator identity does not match",
            );
            return false;
          }
          const now = Date.now();
          if (request.deadline <= now || request.deadline > now + MAX_DEADLINE_AHEAD_MS) {
            void protocolError(
              request.requestId,
              "InvalidDeadline",
              "request deadline is expired or too far ahead",
            );
            return false;
          }
          if (++inFlight > MAX_IN_FLIGHT) {
            void protocolError(
              request.requestId,
              "TooManyRequests",
              "connection has more than eight requests in flight",
            );
            return false;
          }
          void invokeRequest(request, options.handlers, cache, now)
            .then((result) =>
              writeFrame(socket, {
                version: 1,
                type: "response",
                requestId: request.requestId,
                coordinatorRuntimeId: runtimeId,
                ok: true,
                result,
              } satisfies RuntimeResponse),
            )
            .catch((error: unknown) =>
              writeFrame(socket, {
                version: 1,
                type: "response",
                requestId: request.requestId,
                coordinatorRuntimeId: runtimeId,
                ok: false,
                error: {
                  code:
                    error instanceof Error && error.message === "IdempotencyConflict"
                      ? "IdempotencyConflict"
                      : "RequestFailed",
                  message: boundedReason(error),
                },
              } satisfies RuntimeResponse),
            )
            .catch(() => undefined)
            .finally(() => {
              inFlight -= 1;
            });
          return true;
        };
        socket.on("data", (chunk: Buffer) => {
          if (closed) return;
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length > MAX_BUFFER_BYTES && !buffer.includes(0x0a)) {
            void protocolError("unknown", "FrameTooLarge", "request frame exceeds 64 KiB");
            return;
          }
          let newline = buffer.indexOf(0x0a);
          while (newline >= 0 && !closed) {
            const bytes = buffer.subarray(0, newline);
            buffer = buffer.subarray(newline + 1);
            if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES || bytes.includes(0)) {
              void protocolError("unknown", "InvalidFrame", "invalid request frame");
              return;
            }
            let request: RuntimeRequest;
            try {
              const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
              request = parseRequest(JSON.parse(text));
            } catch {
              void protocolError("unknown", "InvalidRequest", "request is not strict v1 NDJSON");
              return;
            }
            if (!acceptRequest(request)) return;
            newline = buffer.indexOf(0x0a);
          }
          if (buffer.length > MAX_BUFFER_BYTES)
            void protocolError("unknown", "FrameTooLarge", "receive buffer exceeds limit");
        });
        socket.once("close", () => {
          sockets.delete(socket);
          connections -= 1;
        });
        socket.on("error", () => undefined);
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.paths.socketPath, resolve);
      });
      let temporary: string | undefined;
      try {
        const socketInfo = await lstat(options.paths.socketPath);
        if (!socketInfo.isSocket() || socketInfo.isSymbolicLink() || socketInfo.uid !== uid) {
          throw new Error("bound path is not an owned Unix socket");
        }
        await chmod(options.paths.socketPath, 0o600);
        const metadata = `${JSON.stringify({
          version: 1,
          workspaceId: options.workspaceId,
          coordinatorSessionId: options.coordinatorSessionId,
          runtimeId,
          pid: process.pid,
          socketPath: options.paths.socketPath,
        })}\n`;
        temporary = `${options.paths.metadataPath}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, metadata, { mode: 0o600, flag: "wx" });
        await rename(temporary, options.paths.metadataPath);
        return {
          runtimeId,
          close: async () => {
            for (const socket of sockets) socket.destroy();
            await closeServer(server);
            await Promise.all([
              unlink(options.paths.socketPath).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
              }),
              unlink(options.paths.metadataPath).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
              }),
            ]);
          },
        };
      } catch (error) {
        for (const socket of sockets) socket.destroy();
        await closeServer(server).catch(() => undefined);
        await Promise.all(
          [options.paths.socketPath, options.paths.metadataPath, temporary].flatMap((path) =>
            path ? [unlink(path).catch(() => undefined)] : [],
          ),
        );
        throw error;
      }
    },
    catch: (cause) =>
      new RuntimeBusFailure({ operation: "start server", reason: boundedReason(cause) }),
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

type RuntimeRequestCommon = {
  readonly socketPath: string;
  readonly workspaceId: string;
  readonly coordinatorSessionId: string;
  readonly timeoutMs: number;
};
type PingRequestOptions = RuntimeRequestCommon & { readonly method: "ping" };
type ReconcileRequestOptions = RuntimeRequestCommon & {
  readonly method: "reconcile";
  readonly idempotencyKey: string;
};
type PublishReadyRequestOptions = RuntimeRequestCommon & {
  readonly method: "publish-ready";
  readonly idempotencyKey: string;
  readonly params: ReadyPublication;
};
type RuntimeRequestOptions =
  | PingRequestOptions
  | ReconcileRequestOptions
  | PublishReadyRequestOptions;

function requestFor(options: RuntimeRequestOptions, requestId: string): RuntimeRequest {
  const base = {
    version: 1,
    type: "request",
    workspaceId: options.workspaceId,
    coordinatorSessionId: options.coordinatorSessionId,
    requestId,
    deadline: Date.now() + options.timeoutMs,
  } as const;
  switch (options.method) {
    case RuntimeMethod.Ping:
      return { ...base, method: RuntimeMethod.Ping, params: {} };
    case RuntimeMethod.Reconcile:
      return {
        ...base,
        method: RuntimeMethod.Reconcile,
        idempotencyKey: options.idempotencyKey,
        params: {},
      };
    case RuntimeMethod.PublishReady:
      return {
        ...base,
        method: RuntimeMethod.PublishReady,
        idempotencyKey: options.idempotencyKey,
        params: options.params,
      };
  }
}

function parseRuntimeResult(
  method: RuntimeMethod,
  value: unknown,
): RuntimeResultByMethod[RuntimeMethod] {
  switch (method) {
    case RuntimeMethod.Ping:
      return decodePingResult(value);
    case RuntimeMethod.Reconcile:
      return decodeRestoreSummary(value);
    case RuntimeMethod.PublishReady:
      return decodePublishReadyResult(value);
  }
}

export function runtimeRequest(
  options: PingRequestOptions,
): Effect.Effect<RuntimeResultByMethod["ping"], RuntimeBusFailure>;
export function runtimeRequest(
  options: ReconcileRequestOptions,
): Effect.Effect<RuntimeResultByMethod["reconcile"], RuntimeBusFailure>;
export function runtimeRequest(
  options: PublishReadyRequestOptions,
): Effect.Effect<RuntimeResultByMethod["publish-ready"], RuntimeBusFailure>;
export function runtimeRequest(
  options: RuntimeRequestOptions,
): Effect.Effect<RuntimeResultByMethod[RuntimeMethod], RuntimeBusFailure> {
  return Effect.tryPromise({
    try: () =>
      new Promise<RuntimeResultByMethod[RuntimeMethod]>((resolve, reject) => {
        const requestId = randomUUID();
        const socket = createConnection(options.socketPath);
        const timer = setTimeout(
          () => socket.destroy(new Error("request timed out")),
          options.timeoutMs,
        );
        let buffer = Buffer.alloc(0);
        let finished = false;
        const finish = (error?: unknown, value?: RuntimeResultByMethod[RuntimeMethod]) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          socket.destroy();
          if (error) reject(error);
          else if (value !== undefined) resolve(value);
          else reject(new Error("response did not contain a result"));
        };
        socket.once("connect", () => {
          void writeFrame(socket, requestFor(options, requestId)).catch(finish);
        });
        socket.on("data", (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          const newline = buffer.indexOf(0x0a);
          if (newline < 0) {
            if (buffer.length > MAX_BUFFER_BYTES) finish(new Error("response frame exceeds limit"));
            return;
          }
          try {
            const bytes = buffer.subarray(0, newline);
            if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES || bytes.includes(0)) {
              throw new Error("invalid response frame");
            }
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            const response = decodeResponse(JSON.parse(text));
            if (!uuid(response.coordinatorRuntimeId)) {
              throw new Error("response runtime ID is invalid");
            }
            if (response.requestId !== requestId) {
              throw new Error("response request ID does not match");
            }
            if (!response.ok) {
              throw new Error(`${response.error.code}: ${response.error.message}`);
            }
            finish(undefined, parseRuntimeResult(options.method, response.result));
          } catch (error) {
            finish(error);
          }
        });
        socket.once("error", finish);
        socket.once("end", () => finish(new Error("connection closed before a response")));
      }),
    catch: (cause) =>
      new RuntimeBusFailure({ operation: options.method, reason: boundedReason(cause) }),
  });
}
