import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient } from "../client";
import { LspDaemon } from "../daemon";
import type { DaemonRequest, LspResult } from "../protocol";

export interface LspDaemonE2EFixture {
  tmpDir: string;
  socketPath: string;
  pidPath: string;
  withClient<T>(run: (client: LspClient) => Promise<T>): Promise<T>;
  callDaemon(req: Omit<DaemonRequest, "id">): Promise<LspResult>;
  restartDaemon(): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createLspDaemonE2EFixture(
  prepareProject?: (tmpDir: string) => void,
): Promise<LspDaemonE2EFixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), "lsp-e2e-"));
  const socketPath = join(tmpDir, "t.sock");
  const pidPath = join(tmpDir, "t.pid");
  const clients = new Set<LspClient>();
  let daemon: LspDaemon | undefined;

  const closeClients = () => {
    for (const client of clients) client.close();
    clients.clear();
  };
  const startDaemon = async () => {
    daemon = new LspDaemon(socketPath, pidPath, 5 * 60_000);
    await daemon.start();
  };
  const cleanup = async () => {
    closeClients();
    try {
      await daemon?.shutdown();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  };
  const cleanupAfterFailure = async (error: unknown): Promise<never> => {
    try {
      await cleanup();
    } catch (cleanupError) {
      // oxlint-disable-next-line eslint/preserve-caught-error -- AggregateError takes cause in its third argument and retains both failures.
      throw new AggregateError([error, cleanupError], "LSP fixture failed and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  };
  const withClient = async <T>(run: (client: LspClient) => Promise<T>): Promise<T> => {
    const client = new LspClient(socketPath, undefined, {
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
    prepareProject?.(tmpDir);
    await startDaemon();
    return {
      tmpDir,
      socketPath,
      pidPath,
      withClient,
      callDaemon: (req) => withClient((client) => client.call(req)),
      async restartDaemon() {
        closeClients();
        try {
          await daemon?.shutdown();
          await startDaemon();
        } catch (error) {
          await cleanupAfterFailure(error);
        }
      },
      cleanup,
    };
  } catch (error) {
    return cleanupAfterFailure(error);
  }
}

export interface TypeScriptE2EProject {
  tmpDir: string;
  socketPath: string;
  pidPath: string;
  typesFile: string;
  mainFile: string;
  effectFile: string;
}

export interface LspE2EFixture extends TypeScriptE2EProject {
  callDaemon(req: Omit<DaemonRequest, "id">): Promise<any>;
  writeFile(relativePath: string, lines: string[] | string): string;
  cleanup(): Promise<void>;
}

export async function createLspE2EFixture(): Promise<LspE2EFixture> {
  let tmpDir: string;
  let typesFile: string;
  let mainFile: string;
  let effectFile: string;

  const writeFile = (relativePath: string, lines: string[] | string): string => {
    const filePath = join(tmpDir, relativePath);
    writeFileSync(filePath, Array.isArray(lines) ? lines.join("\n") : lines, "utf8");
    return filePath;
  };

  const fixture = await createLspDaemonE2EFixture((projectDir) => {
    tmpDir = projectDir;
    symlinkSync(join(process.cwd(), "node_modules"), join(tmpDir, "node_modules"), "dir");
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

    typesFile = writeFile("types.ts", [
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

    mainFile = writeFile("main.ts", [
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
    effectFile = writeFile("effect.ts", ['import { Effect } from "effect";', "Effect.succeed(1);"]);
  });

  return {
    ...fixture,
    typesFile: typesFile!,
    mainFile: mainFile!,
    effectFile: effectFile!,
    writeFile,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
