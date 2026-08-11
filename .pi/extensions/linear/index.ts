import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { LinearAuthManager, createExternalOpener } from "./auth";
import { LinearGateway } from "./client";
import { createLinearTools } from "./tools";

export {
  FileCredentialStore,
  LinearAuthError,
  LinearAuthManager,
  LinearAuthRequiredError,
} from "./auth";
export { LinearGateway } from "./client";
export {
  buildAuthorizationUrl,
  buildOAuthAppSetupUrl,
  createPkceChallenge,
  exchangeAuthorizationCode,
  refreshOAuthToken,
  revokeOAuthToken,
  startLoopbackCallback,
} from "./oauth";
export { createLinearTools } from "./tools";

async function handleAuthCommand(
  auth: LinearAuthManager,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const action = args.trim() || "status";
  try {
    switch (action) {
      case "status":
        ctx.ui.notify(await auth.status(), "info");
        return;
      case "login": {
        const credentials = await auth.login(ctx, ctx.signal);
        ctx.ui.notify(`Linear authentication is ready with scope: ${credentials.scope}.`, "info");
        return;
      }
      case "logout": {
        const result = await auth.logout(ctx.signal);
        if (!result.hadCredentials) {
          ctx.ui.notify("Linear had no stored authentication.", "info");
        } else if (result.revoked) {
          ctx.ui.notify("Linear authentication was revoked and removed.", "info");
        } else {
          ctx.ui.notify(
            "Linear authentication was removed locally. Remote revocation did not complete.",
            "warning",
          );
        }
        return;
      }
      default:
        ctx.ui.notify("Usage: /linear-auth [login|status|logout]", "warning");
    }
  } catch (error) {
    ctx.ui.notify(
      `Linear authentication failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

export default function linearExtension(pi: ExtensionAPI) {
  const auth = new LinearAuthManager({ openExternal: createExternalOpener(pi) });
  const gateway = new LinearGateway(auth);

  for (const tool of createLinearTools(gateway)) pi.registerTool(tool);

  pi.registerCommand("linear-auth", {
    description: "Manage Linear OAuth. Usage: /linear-auth [login|status|logout]",
    handler: (args, ctx) => handleAuthCommand(auth, args, ctx),
  });

  pi.on("session_shutdown", () => {
    auth.shutdown();
  });
}
