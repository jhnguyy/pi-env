import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { LinearAuthCoordinator, createExternalOpener, type LoginMode } from "./auth";
import { LinearGateway } from "./client";
import { LinearErrorCode, asLinearError, linearError } from "./domain";
import { createLinearSdkApi } from "./sdk-adapter";
import { createLinearTools } from "./tools";

interface AuthCommand {
  action: "status" | "list" | "login" | "use" | "logout";
  mode?: LoginMode;
  write?: boolean;
  all?: boolean;
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

function parseAuthCommand(input: string): AuthCommand {
  const parts = tokens(input.trim());
  const action = (parts.shift() || "status") as AuthCommand["action"];
  if (!["status", "list", "login", "use", "logout"].includes(action)) {
    throw linearError(
      LinearErrorCode.Validation,
      "Usage: /linear-auth [status|list|login|use|logout]",
    );
  }
  const command: AuthCommand = { action };
  while (parts.length) {
    const part = parts.shift()!;
    if (part === "--manual") command.mode = "manual";
    else if (part === "--local") command.mode = "local";
    else if (part === "--write") command.write = true;
    else if (part === "--all") command.all = true;
    else if (part === "--client-id") command.clientId = takeFlagValue(parts, part);
    else if (part.startsWith("--client-id=")) command.clientId = part.slice("--client-id=".length);
    else if (part === "--port") command.callbackPort = Number(takeFlagValue(parts, part));
    else if (part.startsWith("--port="))
      command.callbackPort = Number(part.slice("--port=".length));
    else if (part === "--name") command.name = takeFlagValue(parts, part);
    else if (part.startsWith("--name=")) command.name = part.slice("--name=".length);
    else if (!command.reference) command.reference = part;
    else throw linearError(LinearErrorCode.Validation, `Unexpected argument: ${part}`);
  }
  if (
    command.callbackPort !== undefined &&
    (!Number.isInteger(command.callbackPort) ||
      command.callbackPort < 1 ||
      command.callbackPort > 65_535)
  ) {
    throw linearError(
      LinearErrorCode.Validation,
      "--port must be an integer from 1 through 65535.",
    );
  }
  return command;
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

async function handleAuthCommand(
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
            write: command.write ?? false,
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
        if (!command.reference)
          throw linearError(LinearErrorCode.Validation, "Usage: /linear-auth use <connection>");
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

export default function linearExtension(pi: ExtensionAPI) {
  const auth = new LinearAuthCoordinator({
    openExternal: createExternalOpener(pi),
    identifyAccessToken: (accessToken, signal) =>
      createLinearSdkApi(accessToken, signal).identity(),
  });
  const gateway = new LinearGateway(auth, createLinearSdkApi);

  for (const tool of createLinearTools(gateway)) pi.registerTool(tool);
  pi.registerCommand("linear-auth", {
    description: "Manage Linear connections. Usage: /linear-auth [status|list|login|use|logout]",
    handler: (args, ctx) => handleAuthCommand(auth, args, ctx),
  });
  pi.on("session_shutdown", () => auth.shutdown());
}

export { parseAuthCommand };
