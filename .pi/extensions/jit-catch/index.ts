import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { createJitCatchContract } from "./contract";
import { PiEvent, registerAgentTools, ToolCapability } from "../_shared/agent-tools";
import { toAgentTool, toPiTool } from "../_shared/tool-contract";

export default function (pi: ExtensionAPI) {
  const contract = createJitCatchContract(pi.exec.bind(pi));

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
        rendered += `${theme.fg("muted", `\n... (${hiddenLines} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
      }
      return new Text(rendered, 0, 0);
    },
  }));

  pi.on(PiEvent.SessionStart, (_event, ctx: ExtensionContext) => {
    registerAgentTools(pi, {
      tool: toAgentTool(contract, () => ctx),
      capabilities: [ToolCapability.Write, ToolCapability.Execute],
    });
  });
}
