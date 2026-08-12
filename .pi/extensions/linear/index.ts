import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LinearAuthCoordinator, createExternalOpener } from "./auth";
import { LinearGateway } from "./client";
import { handleAuthCommand, parseAuthCommand } from "./command";
import { createLinearSdkApi } from "./sdk-adapter";
import { createLinearTools } from "./tools";

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
