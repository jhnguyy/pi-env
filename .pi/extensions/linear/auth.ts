import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Data, Schema } from "effect";
import {
  buildAuthorizationUrl,
  buildOAuthAppSetupUrl,
  createPkceChallenge,
  exchangeAuthorizationCode,
  refreshOAuthToken,
  revokeOAuthToken,
  startLoopbackCallback,
  type LoopbackCallback,
  type OAuthTokenResponse,
} from "./oauth";

const CredentialsSchema = Schema.Struct({
  version: Schema.Literal(1),
  clientId: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  tokenType: Schema.String,
  scope: Schema.String,
});

export interface LinearCredentials {
  version: 1;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
  scope: string;
}

export class LinearAuthError extends Data.TaggedError("LinearAuthError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class LinearAuthRequiredError extends Data.TaggedError("LinearAuthRequiredError")<{
  readonly message: string;
}> {}

export interface CredentialStore {
  read(): Promise<LinearCredentials | null>;
  write(credentials: LinearCredentials): Promise<void>;
  remove(): Promise<void>;
}

export class FileCredentialStore implements CredentialStore {
  constructor(readonly path = join(getAgentDir(), "linear", "credentials.json")) {}

  async read(): Promise<LinearCredentials | null> {
    let content: string;
    try {
      const metadata = await lstat(this.path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new LinearAuthError({
          message: `Linear credentials at ${this.path} must be a regular file.`,
        });
      }
      if (process.getuid && metadata.uid !== process.getuid()) {
        throw new LinearAuthError({
          message: `Linear credentials at ${this.path} must be owned by the current user.`,
        });
      }
      if ((metadata.mode & 0o077) !== 0) await chmod(this.path, 0o600);
      content = await readFile(this.path, "utf8");
    } catch (cause) {
      if (isMissingFileError(cause)) return null;
      if (cause instanceof LinearAuthError) throw cause;
      throw new LinearAuthError({
        message: `Cannot read Linear credentials from ${this.path}.`,
        cause,
      });
    }

    try {
      return Schema.decodeUnknownSync(CredentialsSchema)(JSON.parse(content)) as LinearCredentials;
    } catch {
      throw new LinearAuthError({
        message: `Linear credentials at ${this.path} are invalid. Run /linear-auth logout, then /linear-auth login.`,
      });
    }
  }

  async write(credentials: LinearCredentials): Promise<void> {
    const directory = dirname(this.path);
    const temporaryDirectory = join(directory, `.write-${process.pid}-${randomUUID()}`);
    const temporaryPath = join(temporaryDirectory, "credentials.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);

    try {
      await mkdir(temporaryDirectory, { mode: 0o700 });
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
      await rm(temporaryDirectory, { recursive: true, force: true });
      await syncDirectory(directory);
    } catch (cause) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw new LinearAuthError({
        message: `Cannot save Linear credentials to ${this.path}.`,
        cause,
      });
    }
  }

  async remove(): Promise<void> {
    try {
      await rm(this.path, { force: true });
    } catch (cause) {
      throw new LinearAuthError({
        message: `Cannot remove Linear credentials from ${this.path}.`,
        cause,
      });
    }
  }
}

function isMissingFileError(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export type LinearAuthContext = Pick<ExtensionContext, "hasUI" | "mode" | "ui">;

export interface AuthManagerOptions {
  store?: CredentialStore;
  now?: () => number;
  fetcher?: typeof fetch;
  callbackPort?: number;
  callbackTimeoutMs?: number;
  clientId?: string;
  openExternal?: (url: string, signal?: AbortSignal) => Promise<boolean>;
  startCallback?: typeof startLoopbackCallback;
}

export interface LogoutResult {
  hadCredentials: boolean;
  revoked: boolean;
}

const DEFAULT_CALLBACK_PORT = 43_921;
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60_000;
const REFRESH_WINDOW_MS = 60_000;
const OAUTH_SCOPES = ["read", "write"] as const;

function credentialsFromToken(
  clientId: string,
  token: OAuthTokenResponse,
  now: number,
): LinearCredentials {
  return {
    version: 1,
    clientId,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: now + token.expiresIn * 1000,
    tokenType: token.tokenType,
    scope: token.scope,
  };
}

function callbackPortFromEnvironment(): number {
  const value = process.env.LINEAR_OAUTH_PORT;
  if (!value) return DEFAULT_CALLBACK_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new LinearAuthError({
      message: "LINEAR_OAUTH_PORT must be an integer from 1 through 65535.",
    });
  }
  return port;
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
      const result = await pi.exec(command, args, { signal, timeout: 10_000 });
      return result.code === 0;
    } catch {
      return false;
    }
  };
}

export class LinearAuthManager {
  readonly store: CredentialStore;
  readonly #now: () => number;
  readonly #fetcher: typeof fetch;
  readonly #callbackPort: number;
  readonly #callbackTimeoutMs: number;
  readonly #configuredClientId?: string;
  readonly #openExternal: (url: string, signal?: AbortSignal) => Promise<boolean>;
  readonly #startCallback: typeof startLoopbackCallback;
  #loginPromise?: Promise<LinearCredentials>;
  #refreshPromise?: Promise<LinearCredentials>;
  #activeLoginController?: AbortController;
  readonly #lifecycleController = new AbortController();

  constructor(options: AuthManagerOptions = {}) {
    this.store = options.store ?? new FileCredentialStore();
    this.#now = options.now ?? Date.now;
    this.#fetcher = options.fetcher ?? fetch;
    this.#callbackPort = options.callbackPort ?? callbackPortFromEnvironment();
    this.#callbackTimeoutMs = options.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
    this.#configuredClientId = options.clientId ?? process.env.LINEAR_OAUTH_CLIENT_ID;
    this.#openExternal = options.openExternal ?? (async () => false);
    this.#startCallback = options.startCallback ?? startLoopbackCallback;
  }

  async status(): Promise<string> {
    const credentials = await this.store.read();
    if (!credentials) return "Linear is not authenticated. Run /linear-auth login.";
    if (credentials.expiresAt <= this.#now()) {
      return "Linear access has expired. The next Linear request will refresh it.";
    }
    return `Linear is authenticated until ${new Date(credentials.expiresAt).toISOString()} with scope: ${credentials.scope}.`;
  }

  async login(
    ctx: LinearAuthContext,
    signal?: AbortSignal,
    force = false,
  ): Promise<LinearCredentials> {
    if (!ctx.hasUI) throw authRequired();
    if (!force) {
      const existing = await this.store.read();
      if (existing && existing.expiresAt > this.#now() + REFRESH_WINDOW_MS) return existing;
      if (existing) {
        try {
          return await this.#refresh(existing, signal);
        } catch {
          // Continue with a new authorization when the stored grant cannot refresh.
        }
      }
    }

    if (!this.#loginPromise) {
      this.#loginPromise = this.#loginOnce(ctx, signal).finally(() => {
        this.#loginPromise = undefined;
        this.#activeLoginController = undefined;
      });
    }
    return this.#loginPromise;
  }

  async accessToken(ctx: LinearAuthContext, signal?: AbortSignal): Promise<string> {
    let credentials = await this.store.read();
    if (!credentials) credentials = await this.login(ctx, signal);
    if (credentials.expiresAt <= this.#now() + REFRESH_WINDOW_MS) {
      try {
        credentials = await this.#refresh(credentials, signal);
      } catch (cause) {
        if (signal?.aborted) throw signal.reason;
        if (!ctx.hasUI)
          throw new LinearAuthRequiredError({
            message: `Linear authentication expired. Run /linear-auth login in TUI or RPC mode. ${errorMessage(cause)}`,
          });
        credentials = await this.login(ctx, signal, true);
      }
    }
    return credentials.accessToken;
  }

  async refreshAfterAuthenticationError(
    ctx: LinearAuthContext,
    signal?: AbortSignal,
  ): Promise<string> {
    const credentials = await this.store.read();
    if (!credentials) return (await this.login(ctx, signal)).accessToken;
    try {
      return (await this.#refresh(credentials, signal)).accessToken;
    } catch (cause) {
      if (signal?.aborted) throw signal.reason;
      if (!ctx.hasUI)
        throw new LinearAuthRequiredError({
          message: `Linear authentication failed. Run /linear-auth login in TUI or RPC mode. ${errorMessage(cause)}`,
        });
      return (await this.login(ctx, signal, true)).accessToken;
    }
  }

  async logout(signal?: AbortSignal): Promise<LogoutResult> {
    let credentials: LinearCredentials | null;
    try {
      credentials = await this.store.read();
    } catch {
      await this.store.remove();
      return { hadCredentials: true, revoked: false };
    }
    if (!credentials) return { hadCredentials: false, revoked: false };

    let revoked = false;
    try {
      revoked = await revokeOAuthToken({
        token: credentials.refreshToken || credentials.accessToken,
        signal,
        fetcher: this.#fetcher,
      });
    } finally {
      await this.store.remove();
    }
    return { hadCredentials: true, revoked };
  }

  shutdown(): void {
    const reason = new Error("Pi session stopped.");
    this.#activeLoginController?.abort(reason);
    this.#lifecycleController.abort(reason);
  }

  async #loginOnce(ctx: LinearAuthContext, signal?: AbortSignal): Promise<LinearCredentials> {
    const controller = new AbortController();
    this.#activeLoginController = controller;
    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal, this.#lifecycleController.signal])
      : AbortSignal.any([controller.signal, this.#lifecycleController.signal]);
    const pkce = createPkceChallenge();
    let callback: LoopbackCallback | undefined;

    try {
      callback = await this.#startCallback({
        port: this.#callbackPort,
        state: pkce.state,
        timeoutMs: this.#callbackTimeoutMs,
        signal: combinedSignal,
      });

      let clientId = this.#configuredClientId ?? (await this.store.read())?.clientId;
      if (!clientId) {
        const setupUrl = buildOAuthAppSetupUrl(callback.redirectUri);
        const opened = await this.#openExternal(setupUrl, combinedSignal);
        if (!opened)
          ctx.ui.notify(`Open this URL to create the OAuth app:\n${setupUrl}`, "warning");
        clientId = (
          await ctx.ui.input(
            "Linear OAuth setup",
            "Create and save the app, then paste its client ID",
            { signal: combinedSignal },
          )
        )?.trim();
        if (!clientId) throw new LinearAuthError({ message: "Linear OAuth setup was cancelled." });
      }

      const authorizationUrl = buildAuthorizationUrl({
        clientId,
        redirectUri: callback.redirectUri,
        scope: OAUTH_SCOPES,
        pkce,
      });
      const opened = await this.#openExternal(authorizationUrl, combinedSignal);
      if (!opened)
        ctx.ui.notify(`Open this URL to authorize Linear:\n${authorizationUrl}`, "warning");

      const code = await callback.code;
      const token = await exchangeAuthorizationCode({
        code,
        clientId,
        redirectUri: callback.redirectUri,
        verifier: pkce.verifier,
        signal: combinedSignal,
        fetcher: this.#fetcher,
      });
      const credentials = credentialsFromToken(clientId, token, this.#now());
      await this.store.write(credentials);
      return credentials;
    } catch (cause) {
      if (cause instanceof LinearAuthError || cause instanceof LinearAuthRequiredError) throw cause;
      throw new LinearAuthError({ message: errorMessage(cause), cause });
    } finally {
      await callback?.close();
    }
  }

  async #refresh(credentials: LinearCredentials, signal?: AbortSignal): Promise<LinearCredentials> {
    if (!this.#refreshPromise) {
      this.#refreshPromise = (async () => {
        const token = await refreshOAuthToken({
          refreshToken: credentials.refreshToken,
          clientId: credentials.clientId,
          signal: this.#lifecycleController.signal,
          fetcher: this.#fetcher,
        });
        const refreshed = credentialsFromToken(credentials.clientId, token, this.#now());
        await this.store.write(refreshed);
        return refreshed;
      })().finally(() => {
        this.#refreshPromise = undefined;
      });
    }
    return waitForShared(this.#refreshPromise, signal);
  }
}

function waitForShared<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function authRequired(): LinearAuthRequiredError {
  return new LinearAuthRequiredError({
    message: "Linear is not authenticated. Run /linear-auth login in TUI or RPC mode.",
  });
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return "Linear authentication failed.";
}
