import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { Schema } from "effect";
import { LinearErrorCode, linearError } from "./domain";

export const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
export const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
export const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";
export const OAUTH_CALLBACK_PATH = "/oauth/callback";

const TokenSchema = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
  token_type: Schema.String,
  scope: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
});
const OAuthErrorSchema = Schema.Struct({
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
  for (const [name, value] of Object.entries({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: input.scope.join(","),
    state: input.pkce.state,
    code_challenge: input.pkce.challenge,
    code_challenge_method: "S256",
  })) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

export function buildOAuthAppSetupUrl(redirectUri: string): string {
  const url = new URL("https://linear.app/settings/api/applications/new");
  for (const [name, value] of Object.entries({
    distribution: "private",
    "display.description": "Connect a local Pi workbench to workspace issues.",
    "oauth.client_name": "Pi Workbench",
    "oauth.redirect_uris": redirectUri,
    "oauth.grant_types": "authorization_code",
  })) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

function respond(response: ServerResponse, status: number, title: string, message: string): void {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`;
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
  response.end(body);
}

function invalidCallback(message: string, recovery?: string): never {
  throw linearError(LinearErrorCode.OAuthInvalidCallback, message, { recovery });
}

function parseCallbackUrl(value: string, redirectUri: string, state: string): string {
  let callback: URL;
  let expected: URL;
  try {
    callback = new URL(value.trim());
    expected = new URL(redirectUri);
  } catch {
    return invalidCallback(
      "The pasted OAuth callback URL is invalid.",
      "Paste the complete URL from the browser address bar.",
    );
  }
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) {
    return invalidCallback("The OAuth callback URL does not match the configured redirect URI.");
  }
  if (callback.searchParams.get("state") !== state) {
    return invalidCallback("The OAuth callback state does not match.");
  }
  const denied = callback.searchParams.get("error");
  if (denied) {
    throw linearError(LinearErrorCode.OAuthDenied, `Linear denied authorization: ${denied}.`);
  }
  return (
    callback.searchParams.get("code") ??
    invalidCallback("The OAuth callback has no authorization code.")
  );
}

export function parseManualCallback(value: string, redirectUri: string, state: string): string {
  return parseCallbackUrl(value, redirectUri, state);
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (cause: unknown) =>
      reject(
        linearError(LinearErrorCode.Conflict, `Cannot listen on 127.0.0.1:${port}.`, {
          recovery:
            "Retry with /linear-auth login --manual, or configure another registered callback port.",
          cause,
        }),
      );
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

export async function startLoopbackCallback(
  options: LoopbackCallbackOptions,
): Promise<LoopbackCallback> {
  options.signal?.throwIfAborted();
  let resolveCode!: (code: string) => void;
  let rejectCode!: (cause: unknown) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  let redirectUri = callbackUri(options.port);
  let settled = false;
  const settle = (complete: () => void): boolean => {
    if (settled) return false;
    settled = true;
    complete();
    return true;
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", redirectUri);
    if (request.method !== "GET" || url.pathname !== OAUTH_CALLBACK_PATH) {
      respond(response, 404, "Not found", "This callback path is not valid.");
      return;
    }
    try {
      const code = parseCallbackUrl(url.toString(), redirectUri, options.state);
      if (!settle(() => resolveCode(code))) {
        respond(response, 409, "Authorization already received", "Return to Pi to continue.");
        return;
      }
      respond(response, 200, "Authorization complete", "You can close this page and return to Pi.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The OAuth callback is invalid.";
      respond(response, 400, "Authorization rejected", message);
      if (cause instanceof Error && "code" in cause && cause.code === LinearErrorCode.OAuthDenied) {
        settle(() => rejectCode(cause));
      }
    }
  });
  await listen(server, options.port);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw linearError(
      LinearErrorCode.NetworkUnavailable,
      "The OAuth callback server has no TCP address.",
    );
  }
  redirectUri = callbackUri(address.port);
  const onServerError = (cause: unknown) =>
    settle(() =>
      rejectCode(
        linearError(LinearErrorCode.NetworkUnavailable, "The OAuth callback server failed.", {
          retryable: true,
          cause,
        }),
      ),
    );
  server.on("error", onServerError);
  const timer = setTimeout(
    () =>
      settle(() =>
        rejectCode(
          linearError(LinearErrorCode.OAuthTimeout, "Linear authorization timed out.", {
            retryable: true,
            recovery: "Run /linear-auth login again.",
          }),
        ),
      ),
    options.timeoutMs,
  );
  timer.unref();
  const onAbort = () =>
    settle(() =>
      rejectCode(
        linearError(LinearErrorCode.OAuthCancelled, "Linear authorization was cancelled."),
      ),
    );
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const close = async () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    server.off("error", onServerError);
    await closeServer(server);
  };
  const code = codePromise.then(
    async (value) => {
      await close();
      return value;
    },
    async (cause: unknown) => {
      await close();
      throw cause;
    },
  );
  return { redirectUri, code, close };
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw linearError(
      LinearErrorCode.Api,
      `Linear OAuth returned invalid JSON with HTTP ${response.status}.`,
    );
  }
}

function decodeToken(payload: unknown): OAuthTokenResponse {
  try {
    const token = Schema.decodeUnknownSync(TokenSchema)(payload);
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresIn: token.expires_in,
      tokenType: token.token_type,
      scope: typeof token.scope === "string" ? token.scope : [...token.scope].join(" "),
    };
  } catch {
    throw linearError(LinearErrorCode.Api, "Linear OAuth returned an invalid token response.");
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
      { retryable: true, cause },
    );
  }
  const payload = await responseJson(response);
  if (response.ok) return decodeToken(payload);
  const oauth = Schema.decodeUnknownOption(OAuthErrorSchema)(payload);
  const code = oauth._tag === "Some" ? oauth.value.error : undefined;
  const description = oauth._tag === "Some" ? oauth.value.error_description : undefined;
  if (code === "invalid_grant") {
    throw linearError(
      LinearErrorCode.OAuthInvalidGrant,
      description ?? "The Linear OAuth grant is invalid.",
      { recovery: "Run /linear-auth login again." },
    );
  }
  throw linearError(
    LinearErrorCode.Api,
    description ?? `Linear OAuth failed with HTTP ${response.status}.`,
    {
      retryable: response.status >= 500,
      details: { status: response.status, ...(code ? { oauthCode: code } : {}) },
    },
  );
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
    return (
      await (input.fetcher ?? fetch)(LINEAR_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: input.token, token_type_hint: "refresh_token" }),
        signal: input.signal,
      })
    ).ok;
  } catch {
    return false;
  }
}
