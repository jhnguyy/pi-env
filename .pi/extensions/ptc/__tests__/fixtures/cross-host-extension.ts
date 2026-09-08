import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { ToolCapability } from "../../../_shared/agent-tools";
import { registerCrossHostTool } from "../../../_shared/register-cross-host-tool";
import type { ToolContract } from "../../../_shared/tool-contract";

const PARAMETERS = Type.Object({ value: Type.String() });
type Params = Static<typeof PARAMETERS>;
const CONTRACT: ToolContract<Params, Record<string, never>, typeof PARAMETERS> = {
  name: "dynamic-cross-host",
  label: "Dynamic Cross Host",
  description: "Returns its value and session working directory",
  parameters: PARAMETERS,
  async execute(params, context) {
    return {
      content: [{ type: "text", text: `${params.value}:${context.cwd}` }],
      details: {},
    };
  },
};

export default function crossHostFixture(pi: ExtensionAPI): void {
  registerCrossHostTool(pi, {
    contract: CONTRACT,
    capabilities: [ToolCapability.Read],
  });
}
