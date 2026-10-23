import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("override-test-mode", { description: "Synthetic override behavior", type: "string", default: "cancel" });
  pi.registerCommand("share", {
    description: "Synthetic private-share command",
    overrideBuiltin: true,
    handler: async (args, ctx) => {
      const mode = pi.getFlag("override-test-mode");
      ctx.ui.notify(`Override entered: ${args}`, "info");
      if (mode === "error") throw new Error("Synthetic override failure");
      if (mode === "confirm") await ctx.ui.confirm("Synthetic override confirmation", "Cancel this dialog without native publication.");
      ctx.ui.notify(`Override handled without upload: ${args}`, "info");
    },
  });
}
