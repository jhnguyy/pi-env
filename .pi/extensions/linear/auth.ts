import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LinearIdentity } from "./api";
import { LinearErrorCode, LinearExtensionError, linearError } from "./domain";
import {
  buildAuthorizationUrl,
  buildOAuthAppSetupUrl,
  callbackUri,
  createPkceChallenge,
  exchangeAuthorizationCode,
  parseManualCallback,
  refreshOAuthToken,
  revokeOAuthToken,
  startLoopbackCallback,
  type LoopbackCallback,
} from "./oauth";
import {
  configuredConnectionSelector,
  resolveConnectionReference,
  selectConnection,
  type LinearSelectionContext,
} from "./selection";
import {
  LinearConfigRepository,
  LinearGrantRepository,
  type LinearAppConfig,
  type LinearConnectionConfig,
  type LinearConfigStore,
  type LinearGrant,
  type LinearGrantStore,
} from "./storage";

export type LinearAuthContext = Pick<
  ExtensionContext,
  "cwd" | "hasUI" | "isProjectTrusted" | "mode" | "ui"
>;
export type LoginMode = "local" | "manual";

export interface LoginOptions {
  mode: LoginMode;
  write: boolean;
  clientId?: string;
  callbackPort?: number;
  name?: string;
}

export interface AuthCoordinatorOptions {
  configRepository?: LinearConfigStore;
  grantRepository?: LinearGrantStore;
  identifyAccessToken: (accessToken: string, signal?: AbortSignal) => Promise<LinearIdentity>;
  now?: () => number;
  fetcher?: typeof fetch;
  openExternal?: (url: string, signal?: AbortSignal) => Promise<boolean>;
  startCallback?: typeof startLoopbackCallback;
  defaultCallbackPort?: number;
  callbackTimeoutMs?: number;
}

export interface AccessGrant {
  accessToken: string;
  connection: LinearConnectionConfig;
}

export interface LinearAuthAccess {
  accessToken(
    ctx: LinearSelectionContext,
    requiredScope: "read" | "write",
    signal?: AbortSignal,
  ): Promise<AccessGrant>;
  refreshAfterAuthenticationError(
    ctx: LinearSelectionContext,
    requiredScope: "read" | "write",
    signal?: AbortSignal,
  ): Promise<AccessGrant>;
}

export interface ConnectionStatus {
  connection: LinearConnectionConfig;
  authenticated: boolean;
  expiresAt?: number;
  scopes: readonly string[];
  selected: boolean;
}

const DEFAULT_CALLBACK_PORT = 43_921;
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60_000;
const REFRESH_WINDOW_MS = 60_000;

function parseCallbackPort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw linearError(
      LinearErrorCode.Validation,
      "LINEAR_OAUTH_PORT must be an integer from 1 through 65535.",
    );
  }
  return port;
}

function parseScopes(scope: string): string[] {
  return [
    ...new Set(
      scope
        .split(/[\s,]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function grantFromToken(
  connectionId: string,
  clientId: string,
  token: Awaited<ReturnType<typeof exchangeAuthorizationCode>>,
  now: number,
): LinearGrant {
  return {
    connectionId,
    clientId,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: now + token.expiresIn * 1000,
    tokenType: token.tokenType,
    scope: token.scope,
  };
}

export function externalOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { command: "xdg-open", args: [url] };
}

export function createExternalOpener(
  pi: ExtensionAPI,
): (url: string, signal?: AbortSignal) => Promise<boolean> {
  return async (url, signal) => {
    const { command, args } = externalOpenCommand(process.platform, url);
    try {
      return (await pi.exec(command, args, { signal, timeout: 10_000 })).code === 0;
    } catch {
      return false;
    }
  };
}

export class LinearAuthCoordinator implements LinearAuthAccess {
  readonly configRepository: LinearConfigStore;
  readonly grantRepository: LinearGrantStore;
  readonly #identifyAccessToken: AuthCoordinatorOptions["identifyAccessToken"];
  readonly #now: () => number;
  readonly #fetcher: typeof fetch;
  readonly #openExternal: (url: string, signal?: AbortSignal) => Promise<boolean>;
  readonly #startCallback: typeof startLoopbackCallback;
  readonly #defaultCallbackPort?: number;
  readonly #callbackTimeoutMs: number;
  readonly #lifecycleController = new AbortController();
  #activeController?: AbortController;
  #tail: Promise<void> = Promise.resolve();
  #generation = 0;

  constructor(options: AuthCoordinatorOptions) {
    this.configRepository = options.configRepository ?? new LinearConfigRepository();
    this.grantRepository = options.grantRepository ?? new LinearGrantRepository();
    this.#identifyAccessToken = options.identifyAccessToken;
    this.#now = options.now ?? Date.now;
    this.#fetcher = options.fetcher ?? fetch;
    this.#openExternal = options.openExternal ?? (async () => false);
    this.#startCallback = options.startCallback ?? startLoopbackCallback;
    this.#defaultCallbackPort = options.defaultCallbackPort;
    this.#callbackTimeoutMs = options.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  }

  login(
    ctx: LinearAuthContext,
    options: LoginOptions,
    signal?: AbortSignal,
  ): Promise<LinearConnectionConfig> {
    if (!ctx.hasUI) {
      return Promise.reject(
        linearError(
          LinearErrorCode.SetupRequired,
          "Linear login requires TUI or RPC interaction.",
          {
            recovery: "Run /linear-auth login from TUI or an RPC client that handles UI prompts.",
          },
        ),
      );
    }
    return this.#exclusive(signal, async (operation) => {
      const app = await this.#selectOrCreateApp(ctx, options, operation.signal);
      const redirectUri = callbackUri(app.callbackPort);
      const pkce = createPkceChallenge();
      const requestedScopes = options.write ? ["read", "write"] : ["read"];
      let callback: LoopbackCallback | undefined;
      try {
        let code: string;
        if (options.mode === "local") {
          callback = await this.#startCallback({
            port: app.callbackPort,
            state: pkce.state,
            timeoutMs: this.#callbackTimeoutMs,
            signal: operation.signal,
          });
        }
        const authorizationUrl = buildAuthorizationUrl({
          clientId: app.clientId,
          redirectUri,
          scope: requestedScopes,
          pkce,
        });
        if (options.mode === "manual") {
          ctx.ui.notify(`Open this URL to authorize Linear:\n${authorizationUrl}`, "info");
        } else if (!(await this.#openExternal(authorizationUrl, operation.signal))) {
          ctx.ui.notify(`Open this URL to authorize Linear:\n${authorizationUrl}`, "warning");
        }
        if (options.mode === "manual") {
          const pasted = await ctx.ui.input(
            "Linear OAuth callback",
            "After the redirect fails, paste the complete browser URL",
            { signal: operation.signal },
          );
          if (!pasted)
            throw linearError(
              LinearErrorCode.OAuthCancelled,
              "Linear authorization was cancelled.",
            );
          code = parseManualCallback(pasted, redirectUri, pkce.state);
        } else {
          code = await callback!.code;
        }
        const token = await exchangeAuthorizationCode({
          code,
          clientId: app.clientId,
          redirectUri,
          verifier: pkce.verifier,
          signal: operation.signal,
          fetcher: this.#fetcher,
        });
        const grantedScopes = parseScopes(token.scope);
        for (const scope of requestedScopes) {
          if (!grantedScopes.includes(scope)) {
            throw linearError(
              LinearErrorCode.InsufficientScope,
              `Linear did not grant the ${scope} scope.`,
            );
          }
        }
        const identity = await this.#identifyAccessToken(token.accessToken, operation.signal);
        const connectionId = `${identity.organization.id}:${identity.viewer.id}`;
        const [configBefore, grantsBefore] = await Promise.all([
          this.configRepository.read(),
          this.grantRepository.read(),
        ]);
        const existing = configBefore.connections[connectionId];
        const previousGrant = grantsBefore.grants[connectionId];
        const timestamp = new Date(this.#now()).toISOString();
        const connection: LinearConnectionConfig = {
          id: connectionId,
          name:
            options.name?.trim() ||
            existing?.name ||
            `${identity.organization.urlKey}/${identity.viewer.email}`,
          appClientId: app.clientId,
          organization: identity.organization,
          viewer: identity.viewer,
          grantedScopes,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
        operation.assertCurrent();
        await this.configRepository.saveConnection(connection);
        try {
          operation.assertCurrent();
          await this.grantRepository.put(
            grantFromToken(connectionId, app.clientId, token, this.#now()),
          );
          operation.assertCurrent();
          return connection;
        } catch (error) {
          if (previousGrant) await this.grantRepository.put(previousGrant);
          else await this.grantRepository.remove(connectionId);
          if (existing) await this.configRepository.saveConnection(existing);
          else await this.configRepository.removeConnection(connectionId);
          throw error;
        }
      } finally {
        await callback?.close();
      }
    });
  }

  async status(ctx: LinearSelectionContext): Promise<ConnectionStatus[]> {
    const [config, grants] = await Promise.all([
      this.configRepository.read(),
      this.grantRepository.read(),
    ]);
    const configuredSelector = await configuredConnectionSelector(ctx);
    const selectedReference = configuredSelector ?? config.defaultConnection;
    const selected = selectedReference
      ? resolveConnectionReference(selectedReference, config).id
      : undefined;
    return Object.values(config.connections).map((connection) => {
      const grant = grants.grants[connection.id];
      return {
        connection,
        authenticated: Boolean(grant),
        ...(grant ? { expiresAt: grant.expiresAt } : {}),
        scopes: grant ? parseScopes(grant.scope) : connection.grantedScopes,
        selected: connection.id === selected,
      };
    });
  }

  async use(reference: string): Promise<LinearConnectionConfig> {
    const config = await this.configRepository.read();
    const connection = resolveConnectionReference(reference, config);
    await this.configRepository.setDefaultConnection(connection.id);
    return connection;
  }

  accessToken(
    ctx: LinearSelectionContext,
    requiredScope: "read" | "write",
    signal?: AbortSignal,
  ): Promise<AccessGrant> {
    return this.#exclusive(signal, async (operation) => {
      const [config, grants] = await Promise.all([
        this.configRepository.read(),
        this.grantRepository.read(),
      ]);
      const connection = await selectConnection(ctx, config, grants);
      let grant = grants.grants[connection.id];
      if (!grant) throw authRequired(connection.id);
      this.#requireScope(grant, requiredScope);
      if (grant.expiresAt <= this.#now() + REFRESH_WINDOW_MS) {
        grant = await this.#refreshGrant(grant, operation);
      }
      operation.assertCurrent();
      return { accessToken: grant.accessToken, connection };
    });
  }

  refreshAfterAuthenticationError(
    ctx: LinearSelectionContext,
    requiredScope: "read" | "write",
    signal?: AbortSignal,
  ): Promise<AccessGrant> {
    return this.#exclusive(signal, async (operation) => {
      const [config, grants] = await Promise.all([
        this.configRepository.read(),
        this.grantRepository.read(),
      ]);
      const connection = await selectConnection(ctx, config, grants);
      const grant = grants.grants[connection.id];
      if (!grant) throw authRequired(connection.id);
      this.#requireScope(grant, requiredScope);
      const refreshed = await this.#refreshGrant(grant, operation);
      operation.assertCurrent();
      return { accessToken: refreshed.accessToken, connection };
    });
  }

  async logout(
    ctx: LinearSelectionContext,
    options: { reference?: string; all?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<{ removed: string[]; revoked: string[] }> {
    this.#generation += 1;
    this.#activeController?.abort(
      linearError(
        LinearErrorCode.OAuthCancelled,
        "Linear logout cancelled the active auth operation.",
      ),
    );
    return this.#exclusive(signal, async () => {
      const [config, grants] = await Promise.all([
        this.configRepository.read(),
        this.grantRepository.read(),
      ]);
      const grantIds = Object.keys(grants.grants);
      const targets = options.all
        ? grantIds
        : !options.reference && grantIds.length === 0
          ? []
          : [(await selectConnection(ctx, config, grants, options.reference)).id];
      const revoked: string[] = [];
      for (const connectionId of targets) {
        const grant = grants.grants[connectionId];
        if (!grant) continue;
        if (
          await revokeOAuthToken({
            token: grant.refreshToken || grant.accessToken,
            signal,
            fetcher: this.#fetcher,
          })
        ) {
          revoked.push(connectionId);
        }
      }
      if (options.all) await this.grantRepository.clear();
      else for (const connectionId of targets) await this.grantRepository.remove(connectionId);
      return { removed: targets, revoked };
    });
  }

  shutdown(): void {
    this.#generation += 1;
    const reason = linearError(LinearErrorCode.OAuthCancelled, "Pi session stopped.");
    this.#activeController?.abort(reason);
    this.#lifecycleController.abort(reason);
  }

  async #selectOrCreateApp(
    ctx: LinearAuthContext,
    options: LoginOptions,
    signal: AbortSignal,
  ): Promise<LinearAppConfig> {
    const config = await this.configRepository.read();
    let clientId = options.clientId?.trim() || process.env.LINEAR_OAUTH_CLIENT_ID?.trim();
    let existing = clientId ? config.apps[clientId] : undefined;
    if (!clientId) {
      const apps = Object.values(config.apps);
      if (apps.length === 1) {
        existing = apps[0];
        clientId = existing?.clientId;
      } else if (apps.length > 1) {
        const selected = await ctx.ui.select(
          "Select a Linear OAuth app",
          apps.map((app) => `${app.clientId} (${callbackUri(app.callbackPort)})`),
          { signal },
        );
        if (!selected)
          throw linearError(
            LinearErrorCode.OAuthCancelled,
            "Linear OAuth app selection was cancelled.",
          );
        clientId = selected.split(" ", 1)[0];
        existing = clientId ? config.apps[clientId] : undefined;
      }
    }
    const port =
      options.callbackPort ??
      existing?.callbackPort ??
      this.#defaultCallbackPort ??
      parseCallbackPort(process.env.LINEAR_OAUTH_PORT) ??
      DEFAULT_CALLBACK_PORT;
    if (!clientId) {
      const setupUrl = buildOAuthAppSetupUrl(callbackUri(port));
      if (options.mode === "manual") {
        ctx.ui.notify(`Open this URL to create the OAuth app:\n${setupUrl}`, "info");
      } else if (!(await this.#openExternal(setupUrl, signal))) {
        ctx.ui.notify(`Open this URL to create the OAuth app:\n${setupUrl}`, "warning");
      }
      clientId = (
        await ctx.ui.input(
          "Linear OAuth app",
          "Complete the app owner and homepage fields, save it, then paste its client ID",
          { signal },
        )
      )?.trim();
      if (!clientId)
        throw linearError(LinearErrorCode.OAuthCancelled, "Linear OAuth app setup was cancelled.");
    }
    const app: LinearAppConfig = {
      clientId,
      callbackPort: port,
      createdAt: existing?.createdAt ?? new Date(this.#now()).toISOString(),
    };
    await this.configRepository.saveApp(app);
    return app;
  }

  async #refreshGrant(grant: LinearGrant, operation: AuthOperation): Promise<LinearGrant> {
    try {
      const token = await refreshOAuthToken({
        refreshToken: grant.refreshToken,
        clientId: grant.clientId,
        signal: operation.signal,
        fetcher: this.#fetcher,
      });
      const refreshed = grantFromToken(grant.connectionId, grant.clientId, token, this.#now());
      operation.assertCurrent();
      await this.grantRepository.put(refreshed);
      operation.assertCurrent();
      return refreshed;
    } catch (error) {
      if (
        error instanceof LinearExtensionError &&
        error.code === LinearErrorCode.OAuthInvalidGrant
      ) {
        operation.assertCurrent();
        await this.grantRepository.remove(grant.connectionId);
        throw authRequired(grant.connectionId);
      }
      throw error;
    }
  }

  #requireScope(grant: LinearGrant, requiredScope: "read" | "write"): void {
    if (parseScopes(grant.scope).includes(requiredScope)) return;
    throw linearError(
      LinearErrorCode.InsufficientScope,
      `The selected Linear connection lacks ${requiredScope} access.`,
      {
        recovery: "Run /linear-auth login --write to grant write access.",
        details: { connectionId: grant.connectionId, requiredScope },
      },
    );
  }

  async #exclusive<T>(
    externalSignal: AbortSignal | undefined,
    operation: (operation: AuthOperation) => Promise<T>,
  ): Promise<T> {
    const requestedGeneration = this.#generation;
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let controller: AbortController | undefined;
    try {
      this.#lifecycleController.signal.throwIfAborted();
      controller = new AbortController();
      this.#activeController = controller;
      const signal = externalSignal
        ? AbortSignal.any([externalSignal, controller.signal, this.#lifecycleController.signal])
        : AbortSignal.any([controller.signal, this.#lifecycleController.signal]);
      signal.throwIfAborted();
      if (requestedGeneration !== this.#generation) {
        throw linearError(
          LinearErrorCode.Conflict,
          "A newer Linear auth operation superseded this request.",
        );
      }
      return await operation({
        signal,
        assertCurrent: () => {
          signal.throwIfAborted();
          if (requestedGeneration !== this.#generation) {
            throw linearError(
              LinearErrorCode.Conflict,
              "A newer Linear auth operation superseded this result.",
            );
          }
        },
      });
    } finally {
      if (controller && this.#activeController === controller) this.#activeController = undefined;
      release();
    }
  }
}

interface AuthOperation {
  signal: AbortSignal;
  assertCurrent(): void;
}

function authRequired(connectionId: string) {
  return linearError(
    LinearErrorCode.AuthRequired,
    "The selected Linear connection is not authenticated.",
    {
      recovery: "Run /linear-auth login.",
      details: { connectionId },
    },
  );
}
