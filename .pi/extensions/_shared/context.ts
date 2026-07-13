import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function isHeadless(ctx: ExtensionContext): boolean {
  return !ctx.hasUI;
}
