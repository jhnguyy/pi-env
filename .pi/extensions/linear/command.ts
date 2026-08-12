import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { LinearAuthCoordinator, LoginMode } from "./auth";
import { LinearErrorCode, asLinearError, linearError } from "./domain";

export type AuthCommand =
  | { action: "status" | "list" }
  | {
      action: "login";
      mode?: LoginMode;
      write: boolean;
      clientId?: string;
      callbackPort?: number;
      name?: string;
    }
  | { action: "use"; reference: string }
  | { action: "logout"; reference?: string; all: boolean };

const AuthAction = {
  Status: "status",
  List: "list",
  Login: "login",
  Use: "use",
  Logout: "logout",
} as const;

type AuthAction = (typeof AuthAction)[keyof typeof AuthAction];

interface ParsedAuthOptions {
  mode?: LoginMode;
  write: boolean;
  all: boolean;
  clientId?: string;
  callbackPort?: number;
  name?: string;
  reference?: string;
}

function tokens(input: string): string[] {
  return [...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3]!,
  );
}

function takeFlagValue(parts: string[], flag: string): string {
  const value = parts.shift();
  if (!value || value.startsWith("--")) {
    throw linearError(LinearErrorCode.Validation, `${flag} requires a value.`);
  }
  return value;
}

export function parseAuthCommand(input: string): AuthCommand {
  const parts = tokens(input.trim());
  const action = parseAuthAction(parts.shift() || AuthAction.Status);
  const options = parseAuthOptions(parts);
  validateCallbackPort(options.callbackPort);
  switch (action) {
    case AuthAction.Status:
    case AuthAction.List:
      rejectUnsupportedOptions(action, options);
      return { action };
    case AuthAction.Login:
      if (options.reference || options.all) unexpectedAuthOptions(action);
      return {
        action,
        mode: options.mode,
        write: options.write,
        clientId: options.clientId,
        callbackPort: options.callbackPort,
        name: options.name,
      };
    case AuthAction.Use:
      if (!options.reference || hasLoginOptions(options) || options.all) {
        throw linearError(LinearErrorCode.Validation, "Usage: /linear-auth use <connection>");
      }
      return { action, reference: options.reference };
    case AuthAction.Logout:
      if (hasLoginOptions(options)) unexpectedAuthOptions(action);
      return { action, reference: options.reference, all: options.all };
  }
}

function parseAuthAction(value: string): AuthAction {
  if (Object.values(AuthAction).includes(value as AuthAction)) return value as AuthAction;
  throw linearError(
    LinearErrorCode.Validation,
    "Usage: /linear-auth [status|list|login|use|logout]",
  );
}

function parseAuthOptions(parts: string[]): ParsedAuthOptions {
  const options: ParsedAuthOptions = { write: false, all: false };
  while (parts.length) applyAuthOption(options, parts.shift()!, parts);
  return options;
}

type AuthOptionHandler = (options: ParsedAuthOptions, value?: string) => void;

const AUTH_OPTION_HANDLERS: Record<string, AuthOptionHandler> = {
  "--manual": (options) => setMode(options, "manual"),
  "--local": (options) => setMode(options, "local"),
  "--write": (options) => {
    options.write = true;
  },
  "--all": (options) => {
    options.all = true;
  },
  "--client-id": (options, value) => {
    options.clientId = value;
  },
  "--port": (options, value) => {
    options.callbackPort = Number(value);
  },
  "--name": (options, value) => {
    options.name = value;
  },
};

function applyAuthOption(options: ParsedAuthOptions, part: string, remaining: string[]): void {
  const [flag, inline] = part.split("=", 2);
  const handler = AUTH_OPTION_HANDLERS[flag!];
  if (handler) {
    const needsValue = flag === "--client-id" || flag === "--port" || flag === "--name";
    handler(options, needsValue ? (inline ?? takeFlagValue(remaining, flag!)) : undefined);
    return;
  }
  if (!part.startsWith("--") && !options.reference) {
    options.reference = part;
    return;
  }
  throw linearError(LinearErrorCode.Validation, `Unexpected argument: ${part}`);
}

function setMode(options: ParsedAuthOptions, mode: LoginMode): void {
  if (options.mode && options.mode !== mode) {
    throw linearError(LinearErrorCode.Validation, "--manual and --local cannot be combined.");
  }
  options.mode = mode;
}

function validateCallbackPort(port: number | undefined): void {
  if (port === undefined) return;
  if (Number.isInteger(port) && port >= 1 && port <= 65_535) return;
  throw linearError(LinearErrorCode.Validation, "--port must be an integer from 1 through 65535.");
}

function hasLoginOptions(options: ParsedAuthOptions): boolean {
  return Boolean(
    options.mode || options.write || options.clientId || options.callbackPort || options.name,
  );
}

function rejectUnsupportedOptions(action: AuthAction, options: ParsedAuthOptions): void {
  if (options.reference || options.all || hasLoginOptions(options)) unexpectedAuthOptions(action);
}

function unexpectedAuthOptions(action: AuthAction): never {
  throw linearError(LinearErrorCode.Validation, `Unexpected options for /linear-auth ${action}.`);
}

function defaultLoginMode(ctx: ExtensionCommandContext): LoginMode {
  if (ctx.mode === "rpc" || process.env.SSH_CONNECTION || process.env.SSH_TTY) return "manual";
  return "local";
}

function formatStatuses(statuses: Awaited<ReturnType<LinearAuthCoordinator["status"]>>): string {
  if (!statuses.length) return "No Linear connections are configured. Run /linear-auth login.";
  return statuses
    .map((status) => {
      const selected = status.selected ? "*" : " ";
      const auth = status.authenticated
        ? `authenticated (${status.scopes.join(", ")})`
        : "not authenticated";
      return `${selected} ${status.connection.name} | ${status.connection.id} | ${auth}`;
    })
    .join("\n");
}

export async function handleAuthCommand(
  auth: LinearAuthCoordinator,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const command = parseAuthCommand(args);
    switch (command.action) {
      case "status":
      case "list":
        ctx.ui.notify(formatStatuses(await auth.status(ctx)), "info");
        return;
      case "login": {
        const connection = await auth.login(
          ctx,
          {
            mode: command.mode ?? defaultLoginMode(ctx),
            write: command.write,
            clientId: command.clientId,
            callbackPort: command.callbackPort,
            name: command.name,
          },
          ctx.signal,
        );
        ctx.ui.notify(
          `Linear connection ready: ${connection.name} (${connection.grantedScopes.join(", ")}).`,
          "info",
        );
        return;
      }
      case "use": {
        const connection = await auth.use(command.reference);
        ctx.ui.notify(`Selected Linear connection: ${connection.name}.`, "info");
        return;
      }
      case "logout": {
        const result = await auth.logout(
          ctx,
          { reference: command.reference, all: command.all },
          ctx.signal,
        );
        const remote =
          result.revoked.length === result.removed.length
            ? "Remote grants revoked."
            : "Some remote revocations did not complete.";
        ctx.ui.notify(
          `Removed ${result.removed.length} Linear grant(s). ${remote}`,
          result.revoked.length === result.removed.length ? "info" : "warning",
        );
      }
    }
  } catch (error) {
    const normalized = asLinearError(error);
    ctx.ui.notify(
      [`Linear ${normalized.code}: ${normalized.message}`, normalized.recovery]
        .filter(Boolean)
        .join("\n"),
      "error",
    );
  }
}
