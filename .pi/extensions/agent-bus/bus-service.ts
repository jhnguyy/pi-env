/**
 * bus-service — module-level BusClient singleton.
 *
 * Single source of truth for the BusClient + FsTransport pair.
 * Both agent-bus/index.ts and orch/manager.ts import from here so all
 * bus operations share one client instance, one cursor file, and one
 * session ID regardless of which extension initiates the session.
 *
 * @stable — This is a cross-extension API. The exported function signatures
 * (initBusService, getBusService) and the BusService shape must not change
 * without updating orch/manager.ts.
 *
 * Known consumers (direct import via ../agent-bus/bus-service):
 *   - agent-bus/index.ts  — calls initBusService() at extension load
 *   - orch/manager.ts     — calls getBusService() to share the same client
 *
 * Why not _shared/? bus-service depends on BusClient + FsTransport which
 * are agent-bus internals. Keeping it here avoids a circular topology.
 */

import { BusClient } from "./bus-client";
import { FsTransport } from "./transport";
import type { BusConfig } from "./types";

// ─── Singleton ───────────────────────────────────────────────

interface BusService {
  client: BusClient;
  transport: FsTransport;
}

/**
 * globalThis key for the BusService singleton.
 *
 * Using globalThis instead of a module-level variable ensures that when
 * this file is bundled into multiple extension bundles (e.g. agent-bus
 * and orch each bundle it inline), all copies share the same live instance.
 * Module-level variables are per-bundle; globalThis is process-wide.
 */
const BUS_SERVICE_KEY = "__pi_bus_service__";

/**
 * Initialize (or return existing) bus service.
 * Reads PI_BUS_SESSION and PI_AGENT_ID from env at construction time;
 * BusClient re-reads them dynamically on every operation, so env changes
 * made after construction (e.g. by bus start or orch start) are picked up.
 */
export function initBusService(): BusService {
  const existing = (globalThis as Record<string, unknown>)[BUS_SERVICE_KEY] as BusService | undefined;
  if (existing) return existing;

  const config: BusConfig = {
    sessionId: process.env.PI_BUS_SESSION ?? null,
    agentId: process.env.PI_AGENT_ID ?? null,
  };
  const transport = new FsTransport();
  const client = new BusClient(transport, config);
  const instance: BusService = { client, transport };
  (globalThis as Record<string, unknown>)[BUS_SERVICE_KEY] = instance;
  return instance;
}

/**
 * Return the existing bus service.
 * Initializes lazily if not yet created (idempotent).
 */
export function getBusService(): BusService {
  return initBusService();
}
