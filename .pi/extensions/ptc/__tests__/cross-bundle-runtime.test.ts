import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { resetAgentToolRegistryForTests } from "../../_shared/agent-tools";
import { resetPtcToolRegistryForTests } from "../../_shared/ptc-tools";
import type { PtcToolCatalog } from "../catalog";
import type { PtcExecutionResult } from "../executor";

const here = dirname(fileURLToPath(import.meta.url));
let fixtureDirectory: string;
let preamblePath: string;
let crossHostExtensionPath: string;
let ptcRuntimePath: string;

beforeAll(() => {
  const cacheDirectory = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(cacheDirectory, { recursive: true });
  fixtureDirectory = mkdtempSync(join(cacheDirectory, "ptc-cross-bundle-"));
  preamblePath = join(fixtureDirectory, "subprocess-preamble.mjs");
  crossHostExtensionPath = join(fixtureDirectory, "cross-host-extension.mjs");
  ptcRuntimePath = join(fixtureDirectory, "ptc-runtime-extension.mjs");

  buildSync({
    entryPoints: [join(here, "../subprocess-preamble.ts")],
    outfile: preamblePath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22.19",
  });
  for (const [entryPoint, outfile] of [
    [join(here, "fixtures/cross-host-extension.ts"), crossHostExtensionPath],
    [join(here, "fixtures/ptc-runtime-extension.ts"), ptcRuntimePath],
  ]) {
    buildSync({
      entryPoints: [entryPoint],
      outfile,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      target: "node22.19",
    });
  }
});

afterAll(() => {
  resetAgentToolRegistryForTests();
  resetPtcToolRegistryForTests();
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

beforeEach(() => {
  resetAgentToolRegistryForTests();
  resetPtcToolRegistryForTests();
});

function createHarness() {
  const active: string[] = [];
  const tools: ToolInfo[] = [];
  const listeners = new Map<string, Array<(...args: any[]) => void>>();

  const createApi = (): ExtensionAPI =>
    ({
      registerTool(tool: ToolDefinition<any, any, any>) {
        tools.push({
          ...tool,
          sourceInfo: {
            source: "extension",
            path: "/test/cross-host",
            scope: "project",
            origin: "top-level",
          },
        });
      },
      getActiveTools: () => [...active],
      setActiveTools: (next: string[]) => active.splice(0, active.length, ...next),
      getAllTools: () => [...tools],
      events: {
        emit(event: string, data: unknown) {
          for (const handler of listeners.get(event) ?? []) handler(data);
        },
        on(event: string, handler: (data: unknown) => void) {
          const current = listeners.get(event) ?? [];
          current.push(handler as (...args: any[]) => void);
          listeners.set(event, current);
          return () =>
            listeners.set(
              event,
              (listeners.get(event) ?? []).filter((entry) => entry !== handler),
            );
        },
      },
      on(event: string, handler: (...args: any[]) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      },
    }) as unknown as ExtensionAPI;

  const trigger = (event: string, ...args: unknown[]): void => {
    for (const handler of listeners.get(event) ?? []) handler(...args);
  };

  return { createApi, trigger };
}

interface RuntimeFixture {
  catalog(): PtcToolCatalog;
  execute(code: string, cwd: string): Promise<PtcExecutionResult>;
}

describe("PTC cross-bundle runtime", () => {
  it(
    "runs a cross-host tool after dynamic activation through separate bundles and API instances",
    async () => {
      const harness = createHarness();
      const ptcApi = harness.createApi();
      const toolApi = harness.createApi();

      const runtimeModule = (await import(pathToFileURL(ptcRuntimePath).href)) as {
        createPtcRuntime(pi: ExtensionAPI, path: string): RuntimeFixture;
      };
      const extensionModule = (await import(pathToFileURL(crossHostExtensionPath).href)) as {
        default(pi: ExtensionAPI): void;
      };
      const runtime = runtimeModule.createPtcRuntime(ptcApi, preamblePath);
      extensionModule.default(toolApi);

      harness.trigger("session_start", { type: "session_start" }, {
        cwd: "/dynamic-session",
      });
      expect(runtime.catalog().callable).toEqual([]);

      ptcApi.setActiveTools(["dynamic-cross-host"]);
      expect(runtime.catalog().callable).toEqual([
        expect.objectContaining({ name: "dynamic-cross-host", key: "dynamic_cross_host" }),
      ]);
      const execution = await runtime.execute(
        'return await tools["dynamic-cross-host"]({ value: "ok" });',
        process.cwd(),
      );
      expect(execution.output).toBe("ok:/dynamic-session");

      harness.trigger("session_shutdown", { type: "session_shutdown" });
      expect(runtime.catalog().callable).toEqual([]);
      expect(runtime.catalog().unavailable).toEqual([
        expect.objectContaining({ name: "dynamic-cross-host", class: "unavailable-tool" }),
      ]);
    },
    15_000,
  );
});
