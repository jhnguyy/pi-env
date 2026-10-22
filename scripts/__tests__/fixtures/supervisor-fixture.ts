import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as ChildFixture from "./child-process-fixture.ts";

const repo = resolve(import.meta.dirname, "../../..");

function readFixturePid(path: string): number {
  const record = readFileSync(path, "utf8");
  const pid = Number(record);
  if (
    !/^[1-9][0-9]*\n$/.test(record) ||
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    pid === process.pid
  ) {
    throw new Error("Invalid fixture PID; refusing to signal it");
  }
  return pid;
}

export function processTreeFixture(script = "supervised-process-tree.ts") {
  const cleanup = new DisposableStack();
  const directory = mkdtempSync(join(tmpdir(), "pi-supervised-tree-"));
  cleanup.defer(() => rmSync(directory, { recursive: true, force: true }));
  const pidFile = join(directory, "child-pid");
  const kill = () => {
    const groupFile = `${pidFile}.parent`;
    if (!existsSync(groupFile)) return;
    const groupId = readFixturePid(groupFile);
    try {
      process.kill(process.platform === "win32" ? groupId : -groupId, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  cleanup.defer(kill);
  return {
    pidFile,
    args: [join(import.meta.dirname, script), pidFile],
    pid: () => readFixturePid(pidFile),
    kill,
    [Symbol.dispose]: () => cleanup.dispose(),
  };
}

type ProcessTree = ReturnType<typeof processTreeFixture>;

export function startSupervisor(
  args: string[],
  {
    cwd = repo,
    env = {},
    tree,
  }: { cwd?: string; env?: NodeJS.ProcessEnv; tree?: ProcessTree } = {},
) {
  return ChildFixture.startChild(
    join(repo, "scripts/node-run.sh"),
    [join(repo, "scripts/run-supervised-node.mjs"), ...args],
    {
      cwd,
      env: { PI_ENV_REPO: repo, ...env },
      cleanupWorkload: tree?.kill,
    },
  );
}
