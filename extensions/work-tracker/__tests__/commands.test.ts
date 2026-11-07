import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerCommands } from "../commands";

describe("/review-retros command", () => {
  it.each([["", 5], ["3", 3]])("uses argument %s to request %i retrospectives", async (args, count) => {
    let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
    const messages: Parameters<ExtensionAPI["sendUserMessage"]>[0][] = [];
    const pi: Pick<ExtensionAPI, "registerCommand" | "sendUserMessage"> = {
      registerCommand(name, registered) {
        expect(name).toBe("review-retros");
        command = registered;
      },
      sendUserMessage(message) { messages.push(message); },
    };
    registerCommands(pi as ExtensionAPI);

    expect(command).toBeDefined();
    await command!.handler(String(args), {} as ExtensionCommandContext);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(
      `Review the last ${count} session retrospectives and propose behavioral improvements.`,
    );
  });
});
