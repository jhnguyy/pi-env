import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PtcExecutor } from "../../executor";
import { ToolRegistry } from "../../tool-registry";

export function createPtcRuntime(pi: ExtensionAPI, preamblePath: string) {
  const registry = new ToolRegistry(pi);
  const executor = new PtcExecutor(registry, preamblePath);
  return {
    catalog: () => registry.getRuntimeSnapshot().catalog,
    execute: (code: string, cwd: string) => executor.execute(code, cwd),
  };
}
