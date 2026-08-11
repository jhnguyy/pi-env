import { chmod, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import {
  externalOpenCommand,
  FileCredentialStore,
  LinearAuthManager,
  LinearAuthRequiredError,
  type CredentialStore,
  type LinearAuthContext,
  type LinearCredentials,
} from "../auth";
import {
  buildAuthorizationUrl,
  createPkceChallenge,
  startLoopbackCallback,
  type LoopbackCallback,
} from "../oauth";

class MemoryCredentialStore implements CredentialStore {
  credentials: LinearCredentials | null;
  writes: LinearCredentials[] = [];
  removals = 0;

  constructor(credentials: LinearCredentials | null = null) {
    this.credentials = credentials;
  }

  async read(): Promise<LinearCredentials | null> {
    return this.credentials;
  }

  async write(credentials: LinearCredentials): Promise<void> {
    this.credentials = credentials;
    this.writes.push(credentials);
  }

  async remove(): Promise<void> {
    this.credentials = null;
    this.removals += 1;
  }
}

function credentials(overrides: Partial<LinearCredentials> = {}): LinearCredentials {
  return {
    version: 1,
    clientId: "client-id",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 2_000,
    tokenType: "Bearer",
    scope: "read write",
    ...overrides,
  };
}

function context(hasUI: boolean, input = vi.fn()): LinearAuthContext {
  return {
    hasUI,
    mode: hasUI ? "tui" : "print",
    ui: { input, notify: vi.fn() } as unknown as LinearAuthContext["ui"],
  };
}

function tokenResponse(accessToken = "new-access", refreshToken = "new-refresh"): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 86_399,
      token_type: "Bearer",
      scope: "read write",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const managers: LinearAuthManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
});

describeIfEnabled("linear", "Linear OAuth", () => {
  it("passes Windows OAuth URLs to an opener without a command shell", () => {
    const url = "https://linear.app/oauth/authorize?client_id=id&scope=read%2Cwrite&state=state";

    expect(externalOpenCommand("win32", url)).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
  });

  it("builds an authorization request with state and S256 PKCE but no client secret", () => {
    const pkce = createPkceChallenge();
    const url = new URL(
      buildAuthorizationUrl({
        clientId: "client-id",
        redirectUri: "http://127.0.0.1:43921/oauth/callback",
        scope: ["read", "write"],
        pkce,
      }),
    );

    expect(url.searchParams.get("state")).toBe(pkce.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(url.searchParams.has("client_secret")).toBe(false);
    expect(pkce.verifier).not.toBe(pkce.challenge);
  });

  it("rejects a wrong callback state, accepts one matching callback, and closes the listener", async () => {
    const callback = await startLoopbackCallback({ port: 0, state: "expected", timeoutMs: 2_000 });
    const wrong = await fetch(`${callback.redirectUri}?code=wrong&state=other`);
    expect(wrong.status).toBe(400);

    const accepted = await fetch(`${callback.redirectUri}?code=accepted&state=expected`);
    expect(accepted.status).toBe(200);
    await expect(callback.code).resolves.toBe("accepted");
    await expect(fetch(`${callback.redirectUri}?code=replay&state=expected`)).rejects.toThrow();
  });

  it("times out and closes the callback listener", async () => {
    const callback = await startLoopbackCallback({ port: 0, state: "expected", timeoutMs: 10 });
    await expect(callback.code).rejects.toThrow("timed out");
    await expect(fetch(`${callback.redirectUri}?code=late&state=expected`)).rejects.toThrow();
  });

  it("stores rotating credentials atomically with owner-only permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "linear-credentials-test-"));
    const path = join(root, "private", "credentials.json");
    const store = new FileCredentialStore(path);

    await store.write(credentials());
    await store.write(
      credentials({ accessToken: "rotated-access", refreshToken: "rotated-refresh" }),
    );

    expect(await store.read()).toMatchObject({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
    });
    expect(await readdir(dirname(path))).toEqual(["credentials.json"]);

    if (process.platform !== "win32") {
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await chmod(path, 0o644);
      await store.read();
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("removes a malformed credential file during logout", async () => {
    const root = await mkdtemp(join(tmpdir(), "linear-logout-test-"));
    const path = join(root, "private", "credentials.json");
    const store = new FileCredentialStore(path);
    await store.write(credentials());
    await writeFile(path, "not valid JSON", { mode: 0o600 });
    const manager = new LinearAuthManager({ store });
    managers.push(manager);

    await expect(manager.logout()).resolves.toEqual({ hadCredentials: true, revoked: false });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails directly in headless mode without starting login", async () => {
    const openExternal = vi.fn(async (_url: string) => true);
    const manager = new LinearAuthManager({ store: new MemoryCredentialStore(), openExternal });
    managers.push(manager);

    await expect(manager.accessToken(context(false))).rejects.toEqual(
      expect.objectContaining<Partial<LinearAuthRequiredError>>({
        message: expect.stringContaining("/linear-auth login"),
      }),
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("starts setup and OAuth lazily, then completes the original access request", async () => {
    const store = new MemoryCredentialStore();
    const input = vi.fn(async () => "created-client-id");
    const openExternal = vi.fn(async (_url: string) => true);
    const close = vi.fn(async () => undefined);
    const startCallback = vi.fn(
      async (): Promise<LoopbackCallback> => ({
        redirectUri: "http://127.0.0.1:43921/oauth/callback",
        code: Promise.resolve("authorization-code"),
        close,
      }),
    );
    const requests: URLSearchParams[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init?.body as URLSearchParams);
      return tokenResponse();
    }) as unknown as typeof fetch;
    const manager = new LinearAuthManager({
      store,
      now: () => 1_000,
      openExternal,
      startCallback,
      fetcher,
    });
    managers.push(manager);

    await expect(manager.accessToken(context(true, input))).resolves.toBe("new-access");

    expect(input).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledTimes(2);
    const authorizationUrl = new URL(openExternal.mock.calls[1]![0]);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.has("client_secret")).toBe(false);
    expect(requests[0]?.get("grant_type")).toBe("authorization_code");
    expect(requests[0]?.has("client_secret")).toBe(false);
    expect(store.credentials).toMatchObject({
      clientId: "created-client-id",
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
    expect(close).toHaveBeenCalled();
  });

  it("refreshes an expired token before use and persists both rotated tokens", async () => {
    const store = new MemoryCredentialStore(credentials({ expiresAt: 1_000 }));
    const requests: URLSearchParams[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init?.body as URLSearchParams);
      return tokenResponse("rotated-access", "rotated-refresh");
    }) as unknown as typeof fetch;
    const manager = new LinearAuthManager({ store, now: () => 2_000, fetcher });
    managers.push(manager);

    await expect(manager.accessToken(context(false))).resolves.toBe("rotated-access");
    expect(requests[0]?.get("grant_type")).toBe("refresh_token");
    expect(requests[0]?.get("refresh_token")).toBe("old-refresh");
    expect(store.writes.at(-1)).toMatchObject({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
    });
  });

  it("does not cancel a shared token rotation when one caller stops waiting", async () => {
    const store = new MemoryCredentialStore(credentials({ expiresAt: 1_000 }));
    let finishRefresh!: (response: Response) => void;
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    let fetchSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      markRefreshStarted();
      return new Promise<Response>((resolve) => {
        finishRefresh = resolve;
      });
    }) as unknown as typeof fetch;
    const manager = new LinearAuthManager({ store, now: () => 2_000, fetcher });
    managers.push(manager);
    const controller = new AbortController();

    const cancelledRequest = manager.accessToken(context(false), controller.signal);
    await refreshStarted;
    const continuingRequest = manager.accessToken(context(false));
    controller.abort(new Error("cancel this caller"));

    await expect(cancelledRequest).rejects.toThrow("cancel this caller");
    expect(fetchSignal?.aborted).toBe(false);
    finishRefresh(tokenResponse("shared-access", "shared-refresh"));
    await expect(continuingRequest).resolves.toBe("shared-access");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("removes local credentials even when remote revocation fails", async () => {
    const store = new MemoryCredentialStore(credentials());
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const manager = new LinearAuthManager({ store, fetcher });
    managers.push(manager);

    await expect(manager.logout()).resolves.toEqual({ hadCredentials: true, revoked: false });
    expect(store.credentials).toBeNull();
    expect(store.removals).toBe(1);
    await expect(manager.logout()).resolves.toEqual({ hadCredentials: false, revoked: false });
  });
});
