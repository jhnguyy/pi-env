import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { Schema } from "effect";
import { LinearErrorCode, linearError } from "./domain";

export const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
export const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
export const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";
export const OAUTH_CALLBACK_PATH = "/oauth/callback";

const OAuthTokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
  token_type: Schema.String,
  scope: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
});
const OAuthErrorResponseSchema = Schema.Struct({
  error: Schema.optionalKey(Schema.String),
  error_description: Schema.optionalKey(Schema.String),
});

export interface OAuthTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  scope: string;
}

export interface PkceChallenge {
  verifier: string;
  challenge: string;
  state: string;
}

export interface LoopbackCallback {
  readonly redirectUri: string;
  readonly code: Promise<string>;
  close(): Promise<void>;
}

export interface LoopbackCallbackOptions {
  port: number;
  state: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export function createPkceChallenge(): PkceChallenge {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest().toString("base64url"),
    state: randomBytes(32).toString("base64url"),
  };
}

export function callbackUri(port: number): string {
  return `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`;
}

export function buildAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  scope: readonly string[];
  pkce: PkceChallenge;
}): string {
  const url = new URL(LINEAR_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scope.join(","));
  url.searchParams.set("state", input.pkce.state);
  url.searchParams.set("code_challenge", input.pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function buildOAuthAppSetupUrl(redirectUri: string): string {
  const url = new URL("https://linear.app/settings/api/applications/new");
  url.searchParams.set("distribution", "private");
  url.searchParams.set("display.description", "Connect a local Pi workbench to workspace issues.");
  url.searchParams.set("oauth.client_name", "Pi Workbench");
  url.searchParams.set("oauth.redirect_uris", redirectUri);
  url.searchParams.set("oauth.grant_types", "authorization_code");
  return url.toString();
}

function callbackPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`;
}

function respond(response: ServerResponse, status: number, title: string, message: string): void {
  const body = callbackPage(title, message);
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
  response.end(body);
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function parseCallbackUrl(
  value: string,
  expectedRedirectUri: string,
  expectedState: string,
): string {
  let callback: URL;
  let expected: URL;
  try {
    callback = new URL(value.trim());
    expected = new URL(expectedRedirectUri);
  } catch {
    throw linearError(
      LinearErrorCode.OAuthInvalidCallback,
      "The pasted OAuth callback URL is invalid.",
      {
        recovery: "Paste the complete URL from the browser address bar.",
      },
    );
  }
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) {
    throw linearError(
      LinearErrorCode.OAuthInvalidCallback,
      "The OAuth callback URL does not match the configured redirect URI.",
    );
  }
  if (callback.searchParams.get("state") !== expectedState) {
    throw linearError(
      LinearErrorCode.OAuthInvalidCallback,
      "The OAuth callback state does not match.",
    );
  }
  const denied = callback.searchParams.get("error");
  if (denied)
    throw linearError(LinearErrorCode.OAuthDenied, `Linear denied authorization: ${denied}.`);
  const code = callback.searchParams.get("code");
  if (!code)
    throw linearError(
      LinearErrorCode.OAuthInvalidCallback,
      "The OAuth callback has no authorization code.",
    );
  return code;
}

export function parseManualCallback(
  value: string,
  expectedRedirectUri: string,
  expectedState: string,
): string {
  return parseCallbackUrl(value, expectedRedirectUri, expectedState);
}

export async function startLoopbackCallback(
  options: LoopbackCallbackOptions,
): Promise<LoopbackCallback> {
  options.signal?.throwIfAborted();
  let settleCode!: (code: string) => void;
  let settleError!: (error: unknown) => void;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  const code = new Promise<string>((resolve, reject) => {
    settleCode = resolve;
    settleError = reject;
  });

  let redirectUri = callbackUri(options.port);
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", redirectUri);
    if (request.method !== "GET" || requestUrl.pathname !== OAUTH_CALLBACK_PATH) {
      respond(response, 404, "Not found", "This callback path is not valid.");
      return;
    }
    try {
      const authorizationCode = parseCallbackUrl(requestUrl.toString(), redirectUri, options.state);
      if (settled) {
        respond(response, 409, "Authorization already received", "Return to Pi to continue.");
        return;
      }
      settled = true;
      respond(response, 200, "Authorization complete", "You can close this page and return to Pi.");
      settleCode(authorizationCode);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The OAuth callback is invalid.";
      respond(response, 400, "Authorization rejected", message);
      if (
        cause instanceof Error &&
        "code" in cause &&
        cause.code === LinearErrorCode.OAuthDenied &&
        !settled
      ) {
        settled = true;
        settleError(cause);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onStartupError = (cause: unknown) =>
      reject(
        linearError(LinearErrorCode.Conflict, `Cannot listen on 127.0.0.1:${options.port}.`, {
          recovery:
            "Retry with /linear-auth login --manual, or configure another registered callback port.",
          cause,
        }),
      );
    server.once("error", onStartupError);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", onStartupError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw linearError(
      LinearErrorCode.NetworkUnavailable,
      "The OAuth callback server has no TCP address.",
    );
  }
  redirectUri = callbackUri(address.port);

  const onServerError = (cause: unknown): void => {
    if (settled) return;
    settled = true;
    settleError(
      linearError(LinearErrorCode.NetworkUnavailable, "The OAuth callback server failed.", {
        retryable: true,
        cause,
      }),
    );
  };
  server.on("error", onServerError);

  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    settleError(
      linearError(LinearErrorCode.OAuthTimeout, "Linear authorization timed out.", {
        retryable: true,
        recovery: "Run /linear-auth login again.",
      }),
    );
  }, options.timeoutMs);
  timer.unref();

  if (options.signal) {
    abortHandler = () => {
      if (settled) return;
      settled = true;
      settleError(
        linearError(LinearErrorCode.OAuthCancelled, "Linear authorization was cancelled."),
      );
    };
    options.signal.addEventListener("abort", abortHandler, { once: true });
  }

  const close = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
    server.off("error", onServerError);
    await closeServer(server);
  };
  const codeWithCleanup = code.then(
    async (value) => {
      await close();
      return value;
    },
    async (error: unknown) => {
      await close();
      throw error;
    },
  );
  return { redirectUri, code: codeWithCleanup, close };
}

async function decodeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw linearError(
      LinearErrorCode.Api,
      `Linear OAuth returned invalid JSON with HTTP ${response.status}.`,
    );
  }
}

async function requestTokens(
  body: URLSearchParams,
  signal: AbortSignal | undefined,
  fetcher: typeof fetch,
): Promise<OAuthTokenResponse> {
  let response: Response;
  try {
    response = await fetcher(LINEAR_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal,
    });
  } catch (cause) {
    throw linearError(
      LinearErrorCode.NetworkUnavailable,
      "Cannot reach the Linear OAuth token endpoint.",
      {
        retryable: true,
        cause,
      },
    );
  }
  const payload = await decodeJson(response);
  if (!response.ok) {
    let oauthCode: string | undefined;
    let description: string | undefined;
    try {
      const decoded = Schema.decodeUnknownSync(OAuthErrorResponseSchema)(payload);
      oauthCode = decoded.error;
      description = decoded.error_description;
    } catch {
      // The stable HTTP classification remains usable without provider error fields.
    }
    if (oauthCode === "invalid_grant") {
      throw linearError(
        LinearErrorCode.OAuthInvalidGrant,
        description ?? "The Linear OAuth grant is invalid.",
        {
          recovery: "Run /linear-auth login again.",
        },
      );
    }
    throw linearError(
      LinearErrorCode.Api,
      description ?? `Linear OAuth failed with HTTP ${response.status}.`,
      {
        retryable: response.status >= 500,
        details: { status: response.status, ...(oauthCode ? { oauthCode } : {}) },
      },
    );
  }
  try {
    const decoded = Schema.decodeUnknownSync(OAuthTokenResponseSchema)(payload);
    return {
      accessToken: decoded.access_token,
      refreshToken: decoded.refresh_token,
      expiresIn: decoded.expires_in,
      tokenType: decoded.token_type,
      scope: typeof decoded.scope === "string" ? decoded.scope : [...decoded.scope].join(" "),
    };
  } catch {
    throw linearError(LinearErrorCode.Api, "Linear OAuth returned an invalid token response.");
  }
}

export function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  verifier: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<OAuthTokenResponse> {
  return requestTokens(
    new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
      grant_type: "authorization_code",
    }),
    input.signal,
    input.fetcher ?? fetch,
  );
}

export function refreshOAuthToken(input: {
  refreshToken: string;
  clientId: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<OAuthTokenResponse> {
  return requestTokens(
    new URLSearchParams({
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      grant_type: "refresh_token",
    }),
    input.signal,
    input.fetcher ?? fetch,
  );
}

export async function revokeOAuthToken(input: {
  token: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<boolean> {
  try {
    const response = await (input.fetcher ?? fetch)(LINEAR_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: input.token, token_type_hint: "refresh_token" }),
      signal: input.signal,
    });
    return response.ok;
  } catch {
    return false;
  }
}
