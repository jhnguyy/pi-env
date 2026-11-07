import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiEvent } from "../_shared/agent-tools";

export interface DevToolsLifecycleState {
  removedStalePostEditMessages: number;
}

function createDevToolsLifecycleState(): DevToolsLifecycleState {
  return { removedStalePostEditMessages: 0 };
}

export function registerDevToolsLifecycle(
  pi: ExtensionAPI,
  state: DevToolsLifecycleState = createDevToolsLifecycleState(),
): DevToolsLifecycleState {
  pi.on(PiEvent.Context, async (event) => {
    const messages = event.messages.filter((message) => {
      const customType = (message as { customType?: string }).customType;
      const keep = customType !== "dev-tools-agent-end";
      if (!keep) state.removedStalePostEditMessages += 1;
      return keep;
    });
    return { messages };
  });

  return state;
}
