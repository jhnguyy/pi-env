import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Contract-only spike: no tools or pi runtime behavior are registered. */
export default function (_pi: ExtensionAPI) {
  return undefined;
}

export * from "./contract";
export * from "./memory";
export * from "./routing";
export * from "./fixtures";
