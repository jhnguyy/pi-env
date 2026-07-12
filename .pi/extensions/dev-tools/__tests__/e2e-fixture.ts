import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LspDaemon } from "../daemon";

export interface TypeScriptE2EProject {
  tmpDir: string;
  socketPath: string;
  pidPath: string;
  typesFile: string;
  mainFile: string;
}

export interface LspE2EFixture extends TypeScriptE2EProject {
  callDaemon(req: object): Promise<any>;
  writeFile(relativePath: string, lines: string[] | string): string;
  cleanup(): Promise<void>;
}

export async function createLspE2EFixture(): Promise<LspE2EFixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), "lsp-e2e-"));
  const socketPath = join(tmpDir, "t.sock");
  const pidPath = join(tmpDir, "t.pid");
  let daemon: LspDaemon | null = null;

  const writeFile = (relativePath: string, lines: string[] | string): string => {
    const filePath = join(tmpDir, relativePath);
    writeFileSync(filePath, Array.isArray(lines) ? lines.join("\n") : lines, "utf8");
    return filePath;
  };

  writeFile("tsconfig.json", JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
    },
  }, null, 2));

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

  const { LspDaemon } = await import("../daemon");
  daemon = new LspDaemon(socketPath, pidPath, 5 * 60_000);
  await daemon.start();

  return {
    tmpDir,
    socketPath,
    pidPath,
    typesFile,
    mainFile,
    writeFile,
    async callDaemon(req: object): Promise<any> {
      const { LspClient } = await import("../client");
      const client = new LspClient(socketPath);
      // Daemon is already fixture-owned; prevent client auto-spawn during tests.
      (client as any).spawnDaemon = async () => {};
      const result = await client.call(req as any);
      client.close();
      return result;
    },
    async cleanup(): Promise<void> {
      try {
        await daemon?.shutdown();
      } catch {}
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
      } catch {}
      try {
        if (existsSync(pidPath)) unlinkSync(pidPath);
      } catch {}
      try {
        rmSync(tmpDir, { recursive: true });
      } catch {}
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
