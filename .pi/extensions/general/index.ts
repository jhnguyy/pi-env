import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as AgentTools from "../_shared/agent-tools";

const TerminalBell = "\u0007";

export default function (pi: ExtensionAPI): void {
  pi.on(AgentTools.PiEvent.AgentSettled, (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    process.stdout.write(TerminalBell);
  });
}
