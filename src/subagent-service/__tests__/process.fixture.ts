import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, watch } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { Operation, Receipt, Snapshot, Submit } from "../contract.js";
import type { Command } from "./client-worker.fixture.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const sources = fileURLToPath(new URL("./", import.meta.url));
const watchdog = 15_000;
export async function bundles(): Promise<string> {
  const cache = join(repo, "node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const output = await mkdtemp(join(cache, "subagent-process-"));
  try {
    await build({ entryPoints: {
      service: join(sources, "service-worker.fixture.ts"),
      client: join(sources, "client-worker.fixture.ts"),
      provider: join(sources, "provider.fixture.ts"),
    }, outdir: output, bundle: true, platform: "node", format: "esm", packages: "external", target: "node24" });
    return output;
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}

type Message = { ready?: boolean; armed?: boolean; paused?: Snapshot; snapshot?: Snapshot; id?: number; result?: unknown; error?: string };
export class Peer {
  readonly events = new EventEmitter();
  snapshot?: Snapshot;
  paused?: Snapshot;
  armed = false;
  ready = false;
  exited = false;
  private sequence = 0;
  readonly transcript: unknown[] = [];
  constructor(readonly process: ChildProcess) {
    process.on("message", (message: Message) => {
      this.transcript.push(message);
      if (message.snapshot) this.snapshot = message.snapshot;
      if (message.paused) this.paused = message.paused;
      if (message.armed) this.armed = true;
      if (message.ready) this.ready = true;
      this.events.emit("change");
      if (message.id !== undefined) this.events.emit(`reply:${message.id}`, message);
    });
    process.on("exit", (code, signal) => { this.exited = true; this.transcript.push({ exit: code, signal }); this.events.emit("change"); });
    process.on("error", (error) => { this.transcript.push(String(error)); this.events.emit("change"); });
    process.stdout?.on("data", (data: Buffer) => this.transcript.push({ stdout: data.toString() }));
    process.stderr?.on("data", (data: Buffer) => this.transcript.push({ stderr: data.toString() }));
  }
  wait<T>(label: string, check: () => T | undefined, allowExit = false): Promise<T> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: T) => { clearTimeout(timer); this.events.off("change", changed); error ? reject(error) : resolve(value!); };
      const changed = () => {
        const value = check();
        if (value !== undefined) finish(undefined, value);
        else if (this.exited && !allowExit) finish(new Error(`${label}: process exited: ${JSON.stringify(this.transcript)}`));
      };
      const timer = setTimeout(() => finish(new Error(`${label}: watchdog: ${JSON.stringify(this.transcript)}`)), watchdog);
      this.events.on("change", changed);
      changed();
    });
  }
  async call<T = unknown>(command: Command extends infer C ? C extends Command ? Omit<C, "id"> : never : never): Promise<T> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const event = `reply:${id}`;
      const timer = setTimeout(() => { this.events.off(event, reply); reject(new Error(`RPC watchdog: ${command.action}`)); }, watchdog);
      const reply = (message: Message) => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolve(message.result as T); };
      this.events.once(event, reply);
      this.process.send({ ...command, id });
    });
  }
  operation(receipt: Receipt, status: Operation["status"]): Promise<Operation> {
    return this.wait(`operation ${receipt.operationId} -> ${status}`, () => this.snapshot?.operations.find((op) => op.operationId === receipt.operationId && op.status === status));
  }
  async kill(): Promise<void> {
    if (!this.exited) this.process.kill("SIGKILL");
    await this.wait("process exit", () => this.exited ? true : undefined, true);
  }
}

export class ProcessFixture {
  root = "";
  readonly peers: Peer[] = [];
  readonly observations: unknown[] = [];
  constructor(readonly output: string, readonly scenario: string) {}
  get state(): string { return join(this.root, "state"); }
  get agent(): string { return join(this.root, "agent"); }
  async start(): Promise<void> {
    this.root = await mkdtemp(join(tmpdir(), "subsvc-"));
    await Promise.all([mkdir(this.state, { mode: 0o700 }), mkdir(this.agent), mkdir(join(this.root, "home"))]);
    await writeFile(join(this.root, "AGENTS.md"), "Synthetic shared subagent workspace. Never use network services.");
    await writeFile(join(this.agent, "settings.json"), JSON.stringify({ extensions: [join(this.output, "provider.js")], defaultProvider: "service-fixture", defaultModel: "faux-1", defaultTools: ["fixture_gate"], retry: { enabled: false } }));
    await writeFile(join(this.agent, "models.json"), JSON.stringify({ providers: { "service-fixture": { apiKey: "synthetic-unused-key" } } }));
    new ProjectTrustStore(this.agent).set(this.root, true);
  }
  spawn(file: string, directory = this.state, input?: string, parentSessionId = "fixture-parent"): Peer {
    const peer = new Peer(fork(join(this.output, file), [directory, this.agent, parentSessionId], {
      cwd: this.root, execArgv: [], stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe", "ipc"],
      env: { PATH: process.env.PATH, HOME: join(this.root, "home"), TMPDIR: this.root, PI_CODING_AGENT_DIR: this.agent, SUBAGENT_FIXTURE_ROOT: this.root, NO_COLOR: "1" },
    }));
    this.peers.push(peer);
    if (input !== undefined) peer.process.stdin?.end(input);
    return peer;
  }
  async service(): Promise<Peer> { const p = this.spawn("service.js"); await p.wait("service ready", () => p.ready ? true : undefined); return p; }
  async client(parentSessionId = "fixture-parent"): Promise<Peer> { const p = this.spawn("client.js", this.state, undefined, parentSessionId); await p.wait("client ready", () => p.ready ? true : undefined); return p; }
  submit(requestId = "shared-submit", task = "blocked initial"): Submit { return { requestId, runId: "fixture-run", name: "shared", task, cwd: this.root, tools: ["fixture_gate"] }; }
  async entered(file = "entered"): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); watcher.close(); error ? reject(error) : resolve(); };
      const check = () => { if (existsSync(join(this.root, file))) finish(); };
      const watcher = watch(this.root, check);
      const timer = setTimeout(() => finish(new Error("external tool entry watchdog")), watchdog);
      check();
    });
  }
  async release(): Promise<void> { await writeFile(join(this.root, "release"), "release"); }
  async effects(): Promise<string[]> {
    if (!existsSync(join(this.root, "effects.jsonl"))) return [];
    return (await readFile(join(this.root, "effects.jsonl"), "utf8")).trim().split("\n");
  }
  async inferenceCalls(): Promise<number> {
    return (await readFile(join(this.root, "requests.jsonl"), "utf8")).trim().split("\n").reduce((sum, line) => sum + (JSON.parse(line) as { calls: number }).calls, 0);
  }
  async holdStartup(): Promise<void> { await writeFile(join(this.root, "hold-startup"), "hold"); }
  async secondWorkspace(): Promise<string> {
    const cwd = join(this.root, "other-workspace");
    await mkdir(cwd);
    new ProjectTrustStore(this.agent).set(cwd, true);
    await rm(join(this.root, "entered"), { force: true });
    return cwd;
  }
  async publicState(): Promise<void> { await chmod(this.state, 0o755); }
  async cleanup(testResult?: { state?: string }): Promise<void> {
    const outcomes = await Promise.allSettled(this.peers.map((p) => p.kill()));
    const retainState = testResult?.state === "fail" || outcomes.some((outcome) => outcome.status === "rejected");
    const evidence = resolve(process.env.PI_ENV_CANARY_ARTIFACT_DIR ?? join(repo, "node_modules/.cache/subagent-service-evidence"), `${this.scenario}-${Date.now()}`);
    await mkdir(evidence, { recursive: true });
    if (this.root && retainState) {
      await cp(this.state, join(evidence, "state"), { recursive: true, filter: (path) => !path.endsWith("/service.sock") }).catch((error: unknown) => {
        this.observations.push({ stateCaptureError: String(error) });
      });
      for (const file of ["effects.jsonl", "requests.jsonl", "entered", "release", "aborted"]) {
        if (existsSync(join(this.root, file))) await cp(join(this.root, file), join(evidence, file));
      }
    }
    await writeFile(join(evidence, "evidence.json"), JSON.stringify({
      scenario: this.scenario, testResult, input: this.submit(),
      expected: "shared ownership, no replay of dispatched effects, private exclusive service",
      actual: this.observations, processes: this.peers.map((p) => p.transcript),
      cleanup: outcomes.map((o) => o.status === "rejected" ? String(o.reason) : o.status),
      stateRetained: retainState,
      reproduce: "node node_modules/vitest/vitest.mjs run --project integration src/subagent-service/__tests__/multiprocess.integration.test.ts",
    }, null, 2));
    console.info(`Subagent process evidence: ${evidence}`);
    if (this.root) await rm(this.root, { recursive: true, force: true });
    const failures = outcomes.flatMap((o) => o.status === "rejected" ? [o.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Process fixture cleanup failed");
  }
}
