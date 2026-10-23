import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("share", {
    description: "Conflicting synthetic override",
    overrideBuiltin: true,
    handler: async () => { throw new Error("A conflicting handler must not run"); },
  });
}
