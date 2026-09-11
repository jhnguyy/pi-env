import type { AgentSettledEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as AgentTools from "../_shared/agent-tools";

const TerminalBell = "\u0007";

type AgentSettledHandler = (event: AgentSettledEvent, context: ExtensionContext) => unknown;

export interface AgentSettledApi {
  on(event: typeof AgentTools.PiEvent.AgentSettled, handler: AgentSettledHandler): void;
}

export default function (pi: AgentSettledApi): void {
  pi.on(AgentTools.PiEvent.AgentSettled, (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    process.stdout.write(TerminalBell);
  });
}
