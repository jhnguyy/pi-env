import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  noopToolingTelemetryRuntime,
  type ToolingTelemetryRuntime,
} from "../../../../src/telemetry/tooling.js";
import { LspClient } from "../client";
import { LspDaemon } from "../daemon";
import type { DaemonRequest, LspResult } from "../protocol";

export interface LspDaemonFixture {
  start(): Promise<void>;
  withClient<T>(run: (client: LspClient) => Promise<T>): Promise<T>;
  callDaemon(req: Omit<DaemonRequest, "id">): Promise<LspResult>;
  restartDaemon(): Promise<void>;
  cleanup(): Promise<void>;
}

export function createLspDaemonFixture(): LspDaemonFixture;
export function createLspDaemonFixture<Project>(
  prepareProject: (directory: string) => Project,
  telemetry?: ToolingTelemetryRuntime,
): LspDaemonFixture & { project: Project };
export function createLspDaemonFixture<Project>(
  prepareProject?: (directory: string) => Project,
  telemetry: ToolingTelemetryRuntime = noopToolingTelemetryRuntime,
): LspDaemonFixture & { project: Project | undefined } {
  const directory = mkdtempSync(join(tmpdir(), "lsp-e2e-"));
  const clients = new Set<LspClient>();
  let daemon: LspDaemon | undefined;

  const closeClients = () => {
    for (const client of clients) client.close();
    clients.clear();
  };
  const start = async () => {
    daemon = new LspDaemon(
      join(directory, "t.sock"),
      join(directory, "t.pid"),
      5 * 60_000,
      telemetry,
    );
    await daemon.start();
  };
  const removeProjectAndReportFailures = (failures: unknown[]) => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 1) throw new AggregateError(failures, "LSP fixture cleanup failed");
    if (failures.length === 1) throw failures[0];
  };
  const cleanup = async () => {
    const failures: unknown[] = [];
    try {
      closeClients();
    } catch (error) {
      failures.push(error);
    }
    try {
      await daemon?.shutdown();
    } catch (error) {
      failures.push(error);
    }
    removeProjectAndReportFailures(failures);
  };
  const withClient = async <T>(run: (client: LspClient) => Promise<T>): Promise<T> => {
    const client = new LspClient(join(directory, "t.sock"), undefined, {
      spawnDaemon: () => {
        throw new Error("E2E requests must use the fixture-owned daemon");
      },
    });
    clients.add(client);
    try {
      return await run(client);
    } finally {
      client.close();
      clients.delete(client);
    }
  };

  try {
    const project = prepareProject?.(directory);
    return {
      project,
      start,
      withClient,
      callDaemon: (req) => withClient((client) => client.call(req)),
      async restartDaemon() {
        closeClients();
        await daemon?.shutdown();
        await start();
      },
      cleanup,
    };
  } catch (error) {
    removeProjectAndReportFailures([error]);
    throw error;
  }
}

export interface TypeScriptLspFixture extends LspDaemonFixture {
  typesFile: string;
  mainFile: string;
  effectFile: string;
  callDaemon(req: Omit<DaemonRequest, "id">): Promise<any>;
  writeFile(relativePath: string, lines: string[] | string): string;
}

export function createTypeScriptLspFixture(): TypeScriptLspFixture {
  const { project, ...fixture } = createLspDaemonFixture((directory) => {
    const writeFile = (relativePath: string, lines: string[] | string): string => {
      const filePath = join(directory, relativePath);
      writeFileSync(filePath, Array.isArray(lines) ? lines.join("\n") : lines, "utf8");
      return filePath;
    };
    symlinkSync(join(process.cwd(), "node_modules"), join(directory, "node_modules"), "dir");
    writeFile(
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "bundler",
            strict: true,
            plugins: [{ name: "@effect/language-service" }],
          },
        },
        null,
        2,
      ),
    );

    const typesFile = writeFile("types.ts", [
      "export interface User {",
      "  name: string;",
      "  age: number;",
      "  email: string;",
      "}",
      "",
      "export function greet(user: User): string {",
      "  return `Hello, ${user.name}!`;",
      "}",
    ]);
    const mainFile = writeFile("main.ts", [
      'import type { User } from "./types";',
      'import { greet } from "./types";',
      "",
      "const bob: User = {",
      "  name: 'Bob',",
      "  age: 30,",
      "  email: 'bob@example.com',",
      "};",
      "",
      "console.log(greet(bob));",
    ]);
    const effectFile = writeFile("effect.ts", [
      'import { Effect } from "effect";',
      "Effect.succeed(1);",
    ]);
    return { typesFile, mainFile, effectFile, writeFile };
  });
  return { ...fixture, ...project };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
