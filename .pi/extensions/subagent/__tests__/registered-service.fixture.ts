import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Owns the same executable/state location service-host connects to, not an alternate backend. */
export class RegisteredServiceFixture {
  private child?: ChildProcess;
  private directory?: string;
  private readonly output: string[] = [];

  constructor(private readonly agentDir: string) {}

  async start(): Promise<void> {
    const entry = fileURLToPath(new URL("../dist/service.js", import.meta.url));
    const agent = await realpath(this.agentDir);
    const identity = createHash("sha256").update(agent).digest("hex").slice(0, 16);
    // Match service-host's authority so the normal registered extension reuses this PID.
    this.directory = join("/tmp", `pi-sa-${process.getuid?.()}-${identity}`, "v2");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.child = fork(entry, [this.directory, agent], {
      execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"], detached: true,
      env: { PATH: process.env.PATH, HOME: dirname(agent), PI_CODING_AGENT_DIR: agent, NO_COLOR: "1" },
    });
    this.child.stdout?.on("data", (data: Buffer) => this.output.push(data.toString()));
    this.child.stderr?.on("data", (data: Buffer) => this.output.push(data.toString()));
    await new Promise<void>((resolve, reject) => {
      const child = this.child!;
      const finish = (error?: Error) => {
        clearTimeout(timer); child.off("message", ready); child.off("error", failed); child.off("exit", exited);
        error ? reject(error) : resolve();
      };
      const ready = (message: unknown) => { if (message && typeof message === "object" && "ready" in message && message.ready) finish(); };
      const failed = (error: Error) => finish(error);
      const exited = () => finish(new Error(`Native service exited before ready: ${this.output.join("")}`));
      const timer = setTimeout(() => finish(new Error(`Native service readiness watchdog: ${this.output.join("")}`)), 15_000);
      child.on("message", ready); child.once("error", failed); child.once("exit", exited);
    });
  }

  async crash(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) throw new Error("Fixture service is not running");
    await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
  }

  async close(): Promise<void> {
    const child = this.child;
    let forced = false;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, 5_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.kill("SIGTERM");
      });
    }
    const evidence = fileURLToPath(new URL("../../../../node_modules/.cache/registered-native-evidence/", import.meta.url));
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, `${Date.now()}-${child?.pid ?? "startup"}.json`), JSON.stringify({
      input: "Registered subagent tools, synthetic native provider and browser editor input",
      expected: "Durable work survives parent disconnect; native target selection and provenance remain intact",
      actual: this.output, pid: child?.pid, exitCode: child?.exitCode, signal: child?.signalCode,
      reproduce: "nub run test:integration .pi/extensions/subagent/__tests__/registered-native.integration.test.ts",
      assertions: "See Vitest result for each named scenario",
    }, null, 2));
    if (this.directory) await rm(dirname(this.directory), { recursive: true, force: true });
    if (forced) throw new Error("Fixture service exceeded its shutdown watchdog; inspect retained service evidence");
  }
}
