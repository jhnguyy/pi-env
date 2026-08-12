import { chmod, mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { LinearAuthCoordinator, externalOpenCommand, type LinearAuthContext } from "../auth";
import { LinearErrorCode, LinearExtensionError } from "../domain";
import {
  buildAuthorizationUrl,
  callbackUri,
  createPkceChallenge,
  parseManualCallback,
  startLoopbackCallback,
  type LoopbackCallback,
} from "../oauth";
import {
  LinearConfigRepository,
  LinearGrantRepository,
  type LinearAppConfig,
  type LinearConfigDocument,
  type LinearConfigStore,
  type LinearConnectionConfig,
  type LinearGrant,
  type LinearGrantsDocument,
  type LinearGrantStore,
} from "../storage";

class MemoryConfigStore implements LinearConfigStore {
  document: LinearConfigDocument;

  constructor(document: LinearConfigDocument = { version: 1, apps: {}, connections: {} }) {
    this.document = structuredClone(document);
  }

  async read() {
    return structuredClone(this.document);
  }

  async saveApp(app: LinearAppConfig) {
    this.document.apps[app.clientId] = structuredClone(app);
    return this.read();
  }

  async saveConnection(connection: LinearConnectionConfig) {
    this.document.connections[connection.id] = structuredClone(connection);
    this.document.defaultConnection ??= connection.id;
    return this.read();
  }

  async removeConnection(connectionId: string) {
    delete this.document.connections[connectionId];
    if (this.document.defaultConnection === connectionId) delete this.document.defaultConnection;
    return this.read();
  }

  async setDefaultConnection(connectionId: string) {
    this.document.defaultConnection = connectionId;
    return this.read();
  }
}

class MemoryGrantStore implements LinearGrantStore {
  document: LinearGrantsDocument;
  writes: LinearGrant[] = [];

  constructor(document: LinearGrantsDocument = { version: 1, grants: {} }) {
    this.document = structuredClone(document);
  }

  async read() {
    return structuredClone(this.document);
  }

  async put(grant: LinearGrant) {
    this.document.grants[grant.connectionId] = structuredClone(grant);
    this.writes.push(structuredClone(grant));
    return this.read();
  }

  async remove(connectionId: string) {
    delete this.document.grants[connectionId];
    return this.read();
  }

  async clear() {
    this.document = { version: 1, grants: {} };
    return this.read();
  }
}

const identity = {
  organization: { id: "org-1", name: "Example", urlKey: "example" },
  viewer: { id: "user-1", name: "Agent User", displayName: "agent", email: "agent@example.com" },
};
const connectionId = "org-1:user-1";

function connection(overrides: Partial<LinearConnectionConfig> = {}): LinearConnectionConfig {
  return {
    id: connectionId,
    name: "example/agent@example.com",
    appClientId: "client-1",
    organization: identity.organization,
    viewer: identity.viewer,
    grantedScopes: ["read"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function grant(overrides: Partial<LinearGrant> = {}): LinearGrant {
  return {
    connectionId,
    clientId: "client-1",
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAt: 100_000,
    tokenType: "Bearer",
    scope: "read",
    ...overrides,
  };
}

function app(overrides: Partial<LinearAppConfig> = {}): LinearAppConfig {
  return {
    clientId: "client-1",
    callbackPort: 43_921,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function context(root: string, input = vi.fn(), select = vi.fn()): LinearAuthContext {
  return {
    cwd: root,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => true,
    ui: { input, select, notify: vi.fn() } as unknown as LinearAuthContext["ui"],
  };
}

function tokenResponse(
  accessToken = "access-new",
  refreshToken = "refresh-new",
  scope = "read",
): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 86_399,
      token_type: "Bearer",
      scope,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

let originalAgentDir: string | undefined;
let root: string;
const coordinators: LinearAuthCoordinator[] = [];

beforeEach(async () => {
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  root = await mkdtemp(join(tmpdir(), "linear-auth-architecture-test-"));
  process.env.PI_CODING_AGENT_DIR = root;
});

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.shutdown();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

function coordinator(
  options: Partial<ConstructorParameters<typeof LinearAuthCoordinator>[0]> = {},
) {
  const instance = new LinearAuthCoordinator({
    identifyAccessToken: async () => identity,
    configRepository: new MemoryConfigStore(),
    grantRepository: new MemoryGrantStore(),
    ...options,
  });
  coordinators.push(instance);
  return instance;
}

describeIfEnabled("linear", "Linear auth architecture", () => {
  it("builds S256 PKCE without a client secret and validates manual callbacks", () => {
    const pkce = createPkceChallenge();
    const redirectUri = callbackUri(43_921);
    const authorization = new URL(
      buildAuthorizationUrl({
        clientId: "client-1",
        redirectUri,
        scope: ["read"],
        pkce,
      }),
    );

    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("state")).toBe(pkce.state);
    expect(authorization.searchParams.has("client_secret")).toBe(false);
    expect(
      parseManualCallback(
        `${redirectUri}?code=accepted&state=${pkce.state}`,
        redirectUri,
        pkce.state,
      ),
    ).toBe("accepted");
    expect(() =>
      parseManualCallback(`${redirectUri}?code=wrong&state=other`, redirectUri, pkce.state),
    ).toThrow();
  });

  it("uses a shell-free Windows browser opener", () => {
    const url = "https://linear.app/oauth/authorize?scope=read&state=state";
    expect(externalOpenCommand("win32", url)).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
  });

  it("accepts one matching loopback callback, rejects wrong state, and closes", async () => {
    const callback = await startLoopbackCallback({ port: 0, state: "expected", timeoutMs: 2_000 });
    expect((await fetch(`${callback.redirectUri}?code=wrong&state=other`)).status).toBe(400);
    expect((await fetch(`${callback.redirectUri}?code=accepted&state=expected`)).status).toBe(200);
    await expect(callback.code).resolves.toBe("accepted");
    await expect(fetch(`${callback.redirectUri}?code=replay&state=expected`)).rejects.toThrow();
  });

  it("does not start login from an API access request", async () => {
    const openExternal = vi.fn(async (_url: string) => true);
    const auth = coordinator({ openExternal });

    await expect(auth.accessToken(context(root), "read")).rejects.toMatchObject({
      code: LinearErrorCode.AuthRequired,
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("completes explicit local login and keeps app config separate from grants", async () => {
    const config = new MemoryConfigStore();
    const grants = new MemoryGrantStore();
    const openExternal = vi.fn(async (_url: string) => true);
    const close = vi.fn(async () => undefined);
    const startCallback = vi.fn(
      async (): Promise<LoopbackCallback> => ({
        redirectUri: callbackUri(43_921),
        code: Promise.resolve("authorization-code"),
        close,
      }),
    );
    const input = vi.fn(async () => "client-1");
    const fetcher = vi.fn(async () => tokenResponse()) as unknown as typeof fetch;
    const auth = coordinator({
      configRepository: config,
      grantRepository: grants,
      openExternal,
      startCallback,
      fetcher,
      now: () => 1_000,
    });

    await expect(
      auth.login(context(root, input), { mode: "local", write: false }),
    ).resolves.toMatchObject({ id: connectionId });

    expect(config.document.apps["client-1"]).toMatchObject({ callbackPort: 43_921 });
    expect(JSON.stringify(config.document)).not.toContain("access-new");
    expect(grants.document.grants[connectionId]).toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-new",
    });
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalled();
  });

  it("stores write scope only after explicit write elevation", async () => {
    const config = new MemoryConfigStore({
      version: 1,
      apps: { "client-1": app() },
      connections: {},
    });
    const grants = new MemoryGrantStore();
    const openExternal = vi.fn(async (_url: string) => true);
    const startCallback = vi.fn(
      async (): Promise<LoopbackCallback> => ({
        redirectUri: callbackUri(43_921),
        code: Promise.resolve("authorization-code"),
        close: vi.fn(async () => undefined),
      }),
    );
    const auth = coordinator({
      configRepository: config,
      grantRepository: grants,
      openExternal,
      startCallback,
      fetcher: vi.fn(async () =>
        tokenResponse("write-access", "write-refresh", "read write"),
      ) as unknown as typeof fetch,
      now: () => 1_000,
    });

    await auth.login(context(root), { mode: "local", write: true });

    const authorization = new URL(openExternal.mock.calls[0]![0]);
    expect(authorization.searchParams.get("scope")).toBe("read,write");
    expect(grants.document.grants[connectionId]?.scope).toBe("read write");
  });

  it("completes explicit manual login from a pasted callback URL", async () => {
    const config = new MemoryConfigStore({
      version: 1,
      apps: { "client-1": app() },
      connections: {},
    });
    const grants = new MemoryGrantStore();
    const openExternal = vi.fn(async (_url: string) => true);
    let manualContext!: LinearAuthContext;
    const input = vi.fn(async () => {
      const notification = (manualContext.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(
        -1,
      )![0] as string;
      const authorization = new URL(notification.split("\n").at(-1)!);
      return `${callbackUri(43_921)}?code=manual-code&state=${authorization.searchParams.get("state")}`;
    });
    const auth = coordinator({
      configRepository: config,
      grantRepository: grants,
      openExternal,
      fetcher: vi.fn(async () => tokenResponse()) as unknown as typeof fetch,
      now: () => 1_000,
    });

    manualContext = context(root, input);
    await expect(
      auth.login(manualContext, { mode: "manual", write: false }),
    ).resolves.toMatchObject({ id: connectionId });
    expect(openExternal).not.toHaveBeenCalled();
    expect(grants.document.grants[connectionId]?.accessToken).toBe("access-new");
  });

  it("rolls back connection metadata when grant persistence fails", async () => {
    const config = new MemoryConfigStore({
      version: 1,
      apps: { "client-1": app() },
      connections: {},
    });
    const grants = new MemoryGrantStore();
    grants.put = vi.fn(async () => {
      throw new Error("disk full");
    });
    const auth = coordinator({
      configRepository: config,
      grantRepository: grants,
      openExternal: vi.fn(async (_url: string) => true),
      startCallback: vi.fn(
        async (): Promise<LoopbackCallback> => ({
          redirectUri: callbackUri(43_921),
          code: Promise.resolve("authorization-code"),
          close: vi.fn(async () => undefined),
        }),
      ),
      fetcher: vi.fn(async () => tokenResponse()) as unknown as typeof fetch,
    });

    await expect(auth.login(context(root), { mode: "local", write: false })).rejects.toThrow(
      "disk full",
    );
    expect(config.document.connections).toEqual({});
    expect(grants.document.grants).toEqual({});
  });

  it("keeps multiple authenticated connections ambiguous until explicitly selected", async () => {
    const second = connection({
      id: "org-2:user-2",
      name: "other/user@example.com",
      organization: { id: "org-2", name: "Other", urlKey: "other" },
      viewer: { id: "user-2", name: "Other User", displayName: "other", email: "user@example.com" },
    });
    const config = new MemoryConfigStore({
      version: 1,
      apps: { "client-1": app() },
      connections: { [connectionId]: connection(), [second.id]: second },
    });
    const grants = new MemoryGrantStore({
      version: 1,
      grants: { [connectionId]: grant(), [second.id]: grant({ connectionId: second.id }) },
    });
    const auth = coordinator({
      configRepository: config,
      grantRepository: grants,
      now: () => 1_000,
    });

    await expect(auth.accessToken(context(root), "read")).rejects.toMatchObject({
      code: LinearErrorCode.ConnectionAmbiguous,
    });
    await auth.use(second.id);
    await expect(auth.accessToken(context(root), "read")).resolves.toMatchObject({
      connection: { id: second.id },
    });
  });

  it("requires explicit write elevation while preserving read access", async () => {
    const config = new MemoryConfigStore({
      version: 1,
      apps: { "client-1": app() },
      connections: { [connectionId]: connection() },
      defaultConnection: connectionId,
    });
    const grants = new MemoryGrantStore({ version: 1, grants: { [connectionId]: grant() } });
    const auth = coordinator({
      configRepository: config,
      grantRepository: grants,
      now: () => 1_000,
    });

    await expect(auth.accessToken(context(root), "read")).resolves.toMatchObject({
      accessToken: "access-old",
    });
    await expect(auth.accessToken(context(root), "write")).rejects.toMatchObject({
      code: LinearErrorCode.InsufficientScope,
    });
  });

  it("makes logout cancel delayed login before it can persist a connection or grant", async () => {
    const config = new MemoryConfigStore({
      version: 1,
      apps: { "client-1": app() },
      connections: {},
    });
    const grants = new MemoryGrantStore();
    let finishExchange!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/oauth/token")) {
        markStarted();
        return new Promise<Response>((resolve) => {
          finishExchange = resolve;
        });
      }
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const auth = coordinator({
      configRepository: config,
      grantRepository: grants,
      openExternal: vi.fn(async (_url: string) => true),
      startCallback: vi.fn(
        async (): Promise<LoopbackCallback> => ({
          redirectUri: callbackUri(43_921),
          code: Promise.resolve("authorization-code"),
          close: vi.fn(async () => undefined),
        }),
      ),
      fetcher,
    });

    const login = auth.login(context(root), { mode: "local", write: false });
    await started;
    const logout = auth.logout(context(root));
    finishExchange(tokenResponse());

    await expect(login).rejects.toBeInstanceOf(LinearExtensionError);
    await expect(logout).resolves.toEqual({ removed: [], revoked: [] });
    expect(config.document.connections).toEqual({});
    expect(grants.document.grants).toEqual({});
  });

  it("makes logout win over a delayed refresh and prevents credential resurrection", async () => {
    const config = new MemoryConfigStore({
      version: 1,
      apps: { "client-1": app() },
      connections: { [connectionId]: connection() },
      defaultConnection: connectionId,
    });
    const grants = new MemoryGrantStore({
      version: 1,
      grants: { [connectionId]: grant({ expiresAt: 0 }) },
    });
    let finishRefresh!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/oauth/token")) {
        markStarted();
        return new Promise<Response>((resolve) => {
          finishRefresh = resolve;
        });
      }
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const auth = coordinator({
      configRepository: config,
      grantRepository: grants,
      fetcher,
      now: () => 1_000,
    });

    const access = auth.accessToken(context(root), "read");
    await started;
    const queuedAccess = auth.accessToken(context(root), "read");
    const logout = auth.logout(context(root));
    finishRefresh(tokenResponse("rotated-access", "rotated-refresh"));

    await expect(access).rejects.toBeInstanceOf(LinearExtensionError);
    await expect(queuedAccess).rejects.toBeInstanceOf(LinearExtensionError);
    await expect(logout).resolves.toMatchObject({ removed: [connectionId] });
    expect(grants.document.grants).toEqual({});
    expect(grants.writes).toHaveLength(0);
  });

  it("does not return a valid token after logout starts during a delayed store read", async () => {
    const config = new MemoryConfigStore({
      version: 1,
      apps: { "client-1": app() },
      connections: { [connectionId]: connection() },
      defaultConnection: connectionId,
    });
    const grants = new MemoryGrantStore({ version: 1, grants: { [connectionId]: grant() } });
    const originalRead = grants.read.bind(grants);
    let finishRead!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let delayed = true;
    grants.read = async () => {
      if (delayed) {
        delayed = false;
        markStarted();
        await new Promise<void>((resolve) => {
          finishRead = resolve;
        });
      }
      return originalRead();
    };
    const auth = coordinator({
      configRepository: config,
      grantRepository: grants,
      fetcher: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      now: () => 1_000,
    });

    const access = auth.accessToken(context(root), "read");
    await started;
    const logout = auth.logout(context(root));
    finishRead();

    await expect(access).rejects.toBeInstanceOf(LinearExtensionError);
    await logout;
    expect(grants.document.grants).toEqual({});
  });

  it("keeps the prior rotating grant when refreshed grant persistence fails", async () => {
    const config = new MemoryConfigStore({
      version: 1,
      apps: { "client-1": app() },
      connections: { [connectionId]: connection() },
      defaultConnection: connectionId,
    });
    const grants = new MemoryGrantStore({
      version: 1,
      grants: { [connectionId]: grant({ expiresAt: 0 }) },
    });
    grants.put = vi.fn(async () => {
      throw new Error("disk full");
    });
    const auth = coordinator({
      configRepository: config,
      grantRepository: grants,
      fetcher: vi.fn(async () =>
        tokenResponse("rotated-access", "rotated-refresh"),
      ) as unknown as typeof fetch,
      now: () => 1_000,
    });

    await expect(auth.accessToken(context(root), "read")).rejects.toThrow("disk full");
    expect(grants.document.grants[connectionId]).toMatchObject({
      accessToken: "access-old",
      refreshToken: "refresh-old",
    });
  });

  it("does not convert a transient refresh failure into interactive login", async () => {
    const config = new MemoryConfigStore({
      version: 1,
      apps: { "client-1": app() },
      connections: { [connectionId]: connection() },
      defaultConnection: connectionId,
    });
    const grants = new MemoryGrantStore({
      version: 1,
      grants: { [connectionId]: grant({ expiresAt: 0 }) },
    });
    const openExternal = vi.fn(async (_url: string) => true);
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const auth = coordinator({
      configRepository: config,
      grantRepository: grants,
      openExternal,
      fetcher,
      now: () => 1_000,
    });

    await expect(auth.accessToken(context(root), "read")).rejects.toMatchObject({
      code: LinearErrorCode.NetworkUnavailable,
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(grants.document.grants[connectionId]).toBeDefined();
  });

  it("preserves app and connection config when logout removes the rotating grant", async () => {
    const config = new MemoryConfigStore({
      version: 1,
      apps: { "client-1": app() },
      connections: { [connectionId]: connection() },
      defaultConnection: connectionId,
    });
    const grants = new MemoryGrantStore({ version: 1, grants: { [connectionId]: grant() } });
    const auth = coordinator({
      configRepository: config,
      grantRepository: grants,
      fetcher: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    });

    await auth.logout(context(root));
    expect(config.document.apps["client-1"]).toBeDefined();
    expect(config.document.connections[connectionId]).toBeDefined();
    expect(grants.document.grants).toEqual({});
  });

  it("stores config and grants in separate owner-only atomic files", async () => {
    const configPath = join(root, "linear", "config.json");
    const grantPath = join(root, "linear", "credentials.json");
    const configRepository = new LinearConfigRepository(configPath);
    const grantRepository = new LinearGrantRepository(grantPath);

    const secondConfigRepository = new LinearConfigRepository(configPath);
    await Promise.all([
      configRepository.saveApp(app()),
      secondConfigRepository.saveApp(app({ clientId: "client-2" })),
    ]);
    await configRepository.saveConnection(connection());
    await grantRepository.put(grant());
    await grantRepository.put(
      grant({ accessToken: "rotated-access", refreshToken: "rotated-refresh" }),
    );

    expect(Object.keys((await configRepository.read()).apps).sort()).toEqual([
      "client-1",
      "client-2",
    ]);
    expect(await readFile(configPath, "utf8")).not.toMatch(
      /access-old|refresh-old|rotated-access|rotated-refresh/,
    );
    expect((await grantRepository.read()).grants[connectionId]).toMatchObject({
      accessToken: "rotated-access",
    });
    expect(await readdir(join(root, "linear"))).toEqual(["config.json", "credentials.json"]);
    if (process.platform !== "win32") {
      expect((await stat(join(root, "linear"))).mode & 0o777).toBe(0o700);
      expect((await stat(grantPath)).mode & 0o777).toBe(0o600);
      await chmod(grantPath, 0o644);
      await grantRepository.read();
      expect((await stat(grantPath)).mode & 0o777).toBe(0o600);
    }
  });
});
