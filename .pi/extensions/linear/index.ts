import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ToolCapability } from "../_shared/agent-tools";
import { getCredentialSource } from "../_shared/credential-source";
import { registerCrossHostTool } from "../_shared/register-cross-host-tool";
import { LinearGateway } from "./client";
import { createLinearSdkApi } from "./sdk-adapter";
import { createLinearContract, linearPiOptions } from "./tools";

export default function linearExtension(pi: ExtensionAPI) {
  const gateway = new LinearGateway(getCredentialSource, createLinearSdkApi);
  registerCrossHostTool(pi, {
    contract: createLinearContract(gateway),
    capabilities: [ToolCapability.Read],
    piOptions: linearPiOptions,
  });
}
