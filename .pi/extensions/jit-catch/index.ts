import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { createJitCatchContract } from "./contract";
import { registerAgentToolsOnSessionStart, ToolCapability } from "../_shared/agent-tools";
import { toAgentTool, toPiTool } from "../_shared/tool-contract";
import { toolExpandKeyHint } from "../_shared/tool-render";

export default function (pi: ExtensionAPI) {
  const contract = createJitCatchContract();

  pi.registerTool(toPiTool(contract, {
    renderCall(params, theme, _ctx) {
      let text = theme.fg("toolTitle", theme.bold("jit_catch"));
      const source = params.diff ? "raw diff" : (params.diff_source ?? "unstaged");
      text += " " + theme.fg("accent", source);
      if (params.ext_name) text += " " + theme.fg("muted", params.ext_name);
      if (params.commit) text += " " + theme.fg("dim", params.commit.slice(0, 8));
      return new Text(text, 0, 0);
    },

    renderResult(result, opts, theme, _ctx) {
      const details = result.details as { anyFailed?: boolean } | null;
      const failed = details?.anyFailed ?? false;
      const first = result.content[0];
      const rawText = first?.type === "text" ? first.text : "";
      const lines = rawText.split("\n");
      const text = opts.expanded ? rawText : (lines[0] ?? "");
      const hiddenLines = Math.max(0, lines.length - 1);

      const isError =
        failed ||
        (details != null && typeof details === "object" && "error" in details);
      const prefix = isError ? "✗ " : "";
      const color = isError ? "error" : "success";
      let rendered = theme.fg(color, prefix + text);
      if (!opts.expanded && hiddenLines > 0) {
        rendered += `${theme.fg("muted", `\n... (${hiddenLines} more lines,`)} ${toolExpandKeyHint()}${theme.fg("muted", ")")}`;
      }
      return new Text(rendered, 0, 0);
    },
  }));

  registerAgentToolsOnSessionStart(pi, (_generation, ctx) => ({
    tool: toAgentTool(contract, () => ctx),
    createTool: ({ cwd, parentContext }) =>
      toAgentTool(contract, () => parentContext ?? { cwd }),
    capabilities: [ToolCapability.Write, ToolCapability.Execute],
  }));
}
