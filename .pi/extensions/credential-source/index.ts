import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { registerCredentialSource } from "../_shared/credential-source";
import { SettingsDecodeError } from "../_shared/settings";
import { findNodeBinaryLite } from "../_shared/node-bin-lite";
import { loadCredentialSourceSettingsEffect } from "./config";
import { createBitwardenProvider, createOnePasswordProvider, providerMap } from "./providers";
import { promptBitwardenSession } from "./prompt";
import { PromptedBitwardenSessionSource } from "./session";
import { CredentialSourceRuntime } from "./source";

export default function credentialSourceExtension(pi: ExtensionAPI) {
  let unregister: (() => void) | undefined;

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    unregister?.();
    unregister = undefined;
    let settings;
    try {
      settings = await Effect.runPromise(loadCredentialSourceSettingsEffect(ctx.cwd));
    } catch (error) {
      const message =
        error instanceof SettingsDecodeError && error.source === "project"
          ? "Project settings cannot define credentialSource. Remove that block and reload Pi."
          : "credentialSource settings are invalid. Check the global Pi settings and reload Pi.";
      ctx.ui.notify(message, "error");
      throw error;
    }
    const bitwardenSession = new PromptedBitwardenSessionSource(() => promptBitwardenSession(ctx));
    const source = new CredentialSourceRuntime(
      settings.entries,
      providerMap([
        createOnePasswordProvider(),
        createBitwardenProvider(
          bitwardenSession,
          join(import.meta.dirname, "bitwarden-runner.js"),
          undefined,
          (name) => findNodeBinaryLite(name, import.meta.url),
        ),
      ]),
    );
    unregister = registerCredentialSource(source);
  });

  pi.on("session_shutdown", () => {
    unregister?.();
    unregister = undefined;
  });
}
