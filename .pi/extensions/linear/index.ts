import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCredentialSource } from "../_shared/credential-source";
import { LinearGateway } from "./client";
import { createLinearSdkApi } from "./sdk-adapter";
import { createLinearTool } from "./tools";

export default function linearExtension(pi: ExtensionAPI) {
  const gateway = new LinearGateway(getCredentialSource, createLinearSdkApi);
  pi.registerTool(createLinearTool(gateway));
}
