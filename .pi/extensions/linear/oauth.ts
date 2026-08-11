import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Data, Schema } from "effect";

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

export class OAuthFlowError extends Data.TaggedError("OAuthFlowError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

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

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

export function createPkceChallenge(): PkceChallenge {
  const verifier = base64Url(randomBytes(32));
  return {
    verifier,
    challenge: base64Url(createHash("sha256").update(verifier).digest()),
    state: base64Url(randomBytes(32)),
  };
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
  const manifest = {
    schemaVersion: "1.0.0",
    distribution: "private",
    display: { description: "Connect a local Pi agent to workspace issues." },
    developer: { name: "Pi user" },
    oauth: {
      client_name: "Pi Issue Client",
      client_uri: "https://linear.app/developers/sdk",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
    },
  };
  const url = new URL("https://linear.app/settings/api/applications/new");
  url.searchParams.set("manifest", JSON.stringify(manifest));
  return url.toString();
}

function callbackPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`;
}

function respond(
  response: import("node:http").ServerResponse,
  status: number,
  title: string,
  message: string,
): void {
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

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || requestUrl.pathname !== OAUTH_CALLBACK_PATH) {
      respond(response, 404, "Not found", "This callback path is not valid.");
      return;
    }

    if (requestUrl.searchParams.get("state") !== options.state) {
      respond(
        response,
        400,
        "Authorization rejected",
        "The OAuth state did not match. Return to Pi and try again.",
      );
      return;
    }

    const oauthError = requestUrl.searchParams.get("error");
    if (oauthError) {
      if (!settled) {
        settled = true;
        settleError(new OAuthFlowError({ message: `Linear denied authorization: ${oauthError}` }));
      }
      respond(
        response,
        400,
        "Authorization rejected",
        "Linear did not authorize the connection. Return to Pi for details.",
      );
      return;
    }

    const authorizationCode = requestUrl.searchParams.get("code");
    if (!authorizationCode) {
      respond(
        response,
        400,
        "Authorization rejected",
        "The callback did not include an authorization code.",
      );
      return;
    }

    if (settled) {
      respond(response, 409, "Authorization already received", "Return to Pi to continue.");
      return;
    }

    settled = true;
    respond(response, 200, "Authorization complete", "You can close this page and return to Pi.");
    settleCode(authorizationCode);
  });

  const onServerError = (cause: unknown): void => {
    if (settled) return;
    settled = true;
    settleError(new OAuthFlowError({ message: "The OAuth callback server failed.", cause }));
  };

  await new Promise<void>((resolve, reject) => {
    const onStartupError = (cause: unknown) =>
      reject(new OAuthFlowError({ message: `Cannot listen on 127.0.0.1:${options.port}.`, cause }));
    server.once("error", onStartupError);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", onStartupError);
      resolve();
    });
  });

  server.on("error", onServerError);

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new OAuthFlowError({ message: "The OAuth callback server has no TCP address." });
  }

  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    settleError(new OAuthFlowError({ message: "Linear authorization timed out." }));
  }, options.timeoutMs);
  timer.unref();

  if (options.signal) {
    abortHandler = () => {
      if (settled) return;
      settled = true;
      settleError(
        new OAuthFlowError({
          message: "Linear authorization was cancelled.",
          cause: options.signal?.reason,
        }),
      );
    };
    options.signal.addEventListener("abort", abortHandler, { once: true });
  }

  const close = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
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

  return {
    redirectUri: `http://127.0.0.1:${address.port}${OAUTH_CALLBACK_PATH}`,
    code: codeWithCleanup,
    close,
  };
}

async function decodeResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new OAuthFlowError({
      message: `Linear OAuth returned HTTP ${response.status} with an invalid JSON body.`,
      cause,
    });
  }
}

function oauthErrorMessage(status: number, body: unknown): string {
  try {
    const decoded = Schema.decodeUnknownSync(OAuthErrorResponseSchema)(body);
    const detail = decoded.error_description ?? decoded.error;
    return detail
      ? `Linear OAuth failed with HTTP ${status}: ${detail}`
      : `Linear OAuth failed with HTTP ${status}.`;
  } catch {
    return `Linear OAuth failed with HTTP ${status}.`;
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
    throw new OAuthFlowError({ message: "Cannot reach the Linear OAuth token endpoint.", cause });
  }

  const payload = await decodeResponse(response);
  if (!response.ok)
    throw new OAuthFlowError({ message: oauthErrorMessage(response.status, payload) });

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
    throw new OAuthFlowError({ message: "Linear OAuth returned an invalid token response." });
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
