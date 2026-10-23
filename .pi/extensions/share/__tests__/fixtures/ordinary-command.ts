import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("share", {
    description: "An ordinary command must not replace a built-in",
    handler: async (_args, ctx) => { ctx.ui.notify("An ordinary handler must not run", "error"); },
  });
}
