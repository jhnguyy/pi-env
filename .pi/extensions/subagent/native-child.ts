/** A retained native owner. No transcript, model runtime, or tools are borrowed from the parent. */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  createCodemodeExtension,
  createToolSearchExtension,
  createMcpExtension,
  getAgentDir,
  SettingsManager,
  ExtensionRunner,
  ModelRegistry,
  type AgentSessionServices,
  type AgentSession,
  type ExtensionContext,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { getChildContext, withChildContext } from "../_shared/child-context";
import type { ResolvedSubagentRun, RunSubagentOptions } from "./execution-types";
import { isProjectTrustedForCwd } from "./resolver";
import { WorkspaceAccess, type SubagentRunSupervisor } from "./control";
import { SubagentRunAccumulator } from "./usage";
import type { SubagentDetails } from "./types";

import type { NativeInputMode, NativeInputResult, NativeChildInput, NativeChildSnapshot, NativeChildSummary, NativeChildSession } from "./child-types";
export type { NativeInputMode, NativeInputResult, NativeChildInput, NativeChildSnapshot, NativeChildSummary, NativeChildSession } from "./child-types";

export class NativeChildOwner implements NativeChildSession {
  readonly id: string;
  readonly runId: string;
  private readonly agentDir = getChildContext()?.agentDir ?? getAgentDir();
  private session?: AgentSession;
  private startupServices?: AgentSessionServices;
  private activeSignal?: AbortSignal;
  private state: NativeChildSnapshot["state"] = "idle";
  private readonly inputs: NativeChildInput[] = [];
  private initialResult?: SubagentDetails;
  private operation?: Promise<unknown>;
  private controller?: AbortController;
  private closing?: Promise<void>;
  private teardown?: Promise<void>;
  private readonly pendingInputs = new Set<Promise<NativeInputResult>>();
  private updateUsage?: (usage: SubagentDetails["usage"]) => void;

  constructor(
    private readonly run: ResolvedSubagentRun,
    private readonly ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
    private readonly manager: SessionManager,
    private readonly supervisor: SubagentRunSupervisor,
    private readonly options: RunSubagentOptions,
  ) {
    this.id = manager.getSessionId();
    this.runId = options.runId ?? randomUUID();
  }

  private context<T>(operation: () => T): T {
    return withChildContext({ cwd: this.run.cwd, agentDir: this.agentDir, id: this.id }, operation);
  }

  summary(): NativeChildSummary {
    return {
      id: this.id, runId: this.runId, name: this.run.name, task: this.run.task, cwd: this.run.cwd,
      sessionFile: this.manager.getSessionFile(),
      model: this.session?.model ? `${this.session.model.provider}/${this.session.model.id}` : undefined,
      state: this.state,
    };
  }

  inspect(): NativeChildSnapshot {
    const session = this.session;
    return {
      id: this.id,
      runId: this.runId,
      name: this.run.name,
      task: this.run.task,
      cwd: this.run.cwd,
      sessionFile: this.manager.getSessionFile(),
      model: session?.model ? `${session.model.provider}/${session.model.id}` : undefined,
      systemPrompt: session?.systemPrompt ?? "",
      activeTools: session?.getActiveToolNames() ?? [],
      callableTools: session?.getCallableToolNames() ?? [],
      messages: structuredClone(session?.messages ?? []),
      inputs: structuredClone(this.inputs),
      state: this.state,
      initialResult: this.initialResult && structuredClone(this.initialResult),
    };
  }

  private async start(): Promise<void> {
    const trusted = isProjectTrustedForCwd(this.ctx, this.run.cwd);
    const services = this.startupServices = await createAgentSessionServices({
      cwd: this.run.cwd,
      agentDir: this.agentDir,
      settingsManager: SettingsManager.create(this.run.cwd, this.agentDir, {
        projectTrusted: trusted,
      }),
      modelRuntimeSignal: this.activeSignal,
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => trusted },
      resourceLoaderOptions: {
        extensionFactories: [
          createCodemodeExtension(),
          createToolSearchExtension(),
          createMcpExtension(),
          (pi) => {
            // Native abort does not latch across asynchronous input preflight.
            // Run last so a cancelled preflight never starts a new model turn.
            pi.on("input", () => this.activeSignal?.aborted ? { action: "handled" } : undefined);
            pi.on("before_agent_start", () => {
              // Auth resolution can await after input hooks. Native startup is busy
              // here, so abort latches before the first provider request.
              if (this.activeSignal?.aborted) void this.session?.abort();
            });
          },
        ],
        // Preserve native SYSTEM/AGENTS/skills composition, then append delegated instructions.
        appendSystemPromptOverride: (base) => [
          ...base,
          ...(this.run.systemPrompt ? [this.run.systemPrompt] : []),
        ],
      },
    });
    this.activeSignal?.throwIfAborted();
    const failures = [
      ...services.diagnostics.filter((d) => d.type === "error").map((d) => d.message),
      ...services.resourceLoader.getExtensions().errors.map((e) => `${e.path}: ${e.error}`),
    ];
    if (failures.length) throw new Error(`Child startup failed: ${failures.join("; ")}`);
    let model;
    if (this.run.modelOverride !== undefined) {
      const requested = this.run.modelOverride;
      const matches = (await services.modelRuntime.getAvailable()).filter(
        (candidate) =>
          `${candidate.provider}/${candidate.id}` === requested || candidate.id === requested,
      );
      if (matches.length !== 1)
        throw new Error(`Child model unavailable or ambiguous: "${requested}"`);
      model = matches[0];
    }
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: this.manager,
      model,
      thinkingLevel: this.run.reasoning,
      tools: this.run.toolNames && [...this.run.toolNames],
      customTools: this.run.customTools && [...this.run.customTools],
    });
    this.session = result.session;
    this.startupServices = undefined;
    await this.session.bindExtensions({ mode: "print" });
    if (this.run.toolNames !== undefined) {
      const available = new Set(this.session.getAllTools().map((tool) => tool.name));
      const missing = this.run.toolNames.filter((name) => !available.has(name));
      if (missing.length) throw new Error(`Child tools unavailable: ${missing.join(", ")}`);
      // Only exact names are accepted at this boundary, never aliases or capabilities.
      this.session.setActiveToolsByName([...this.run.toolNames]);
    }
  }

  private record(text: string, mode: NativeInputMode, source: NativeChildInput["source"]): void {
    const entry = { text, mode, source, at: new Date().toISOString() };
    this.inputs.push(entry);
    this.manager.appendCustomEntry("subagent-input", entry);
  }

  private schedule<T>(initial: boolean, operation: () => Promise<T>): Promise<T> {
    if (this.state !== "idle") return Promise.reject(new Error(`Child is ${this.state}`));
    // Reserve before asynchronous admission: a second idle prompt cannot become a second writer.
    this.state = "queued";
    const controller = (this.controller = new AbortController());
    const signal =
      initial && this.options.signal
        ? AbortSignal.any([controller.signal, this.options.signal])
        : controller.signal;
    const pending = this.context(async () => {
      const lease = await this.supervisor.acquire({
        runId: initial ? this.runId : `${this.runId}:human:${randomUUID()}`,
        cwd: this.run.cwd,
        workspaceAccess: WorkspaceAccess.Write,
        signal,
      });
      this.activeSignal = lease.signal;
      this.updateUsage = (usage) => lease.updateUsage(usage);
      const abort = () => {
        void this.context(() => this.session?.abort());
      };
      lease.signal.addEventListener("abort", abort);
      try {
        if (initial) {
          this.options.onAdmitted?.();
          await this.start();
        }
        if (lease.signal.aborted || this.state === "closing") throw new Error("Child cancelled");
        this.state = "running";
        return await operation();
      } catch (error) {
        if (initial) {
          this.state = "closing";
          await this.session?.abort();
          await this.teardownNative();
        }
        throw error;
      } finally {
        // Input hooks can outlive the streaming turn. Keep admission until known
        // hooks and native execution settle; an abort request is not settlement.
        await Promise.allSettled([...this.pendingInputs]);
        await this.session?.waitForIdle();
        lease.signal.removeEventListener("abort", abort);
        this.updateUsage = undefined;
        this.activeSignal = undefined;
        lease.release();
      }
    });
    this.operation = pending;
    return pending.finally(() => {
      this.operation = undefined;
      this.controller = undefined;
      if (this.state !== "closing" && this.state !== "closed") this.state = "idle";
      this.supervisor.pruneChildren();
    });
  }

  async runInitial(): Promise<AgentToolResult<SubagentDetails>> {
    try {
      return await this.schedule(true, async () => {
        const session = this.session!;
        const accumulator = new SubagentRunAccumulator(
          {
            name: this.run.name,
            task: this.run.task,
            cwd: this.run.cwd,
            toolNames: session.getActiveToolNames(),
            modelOverride: this.run.modelOverride,
            maxTurns: this.run.maxTurns,
            sessionId: this.id,
            sessionFile: this.manager.getSessionFile(),
            sessionName: this.manager.getSessionName() ?? this.run.name,
          },
          (turns) => this.run.maxTurns !== undefined && turns >= this.run.maxTurns,
        );
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "message_end" || event.type === "tool_execution_start")
            accumulator.acceptEvent(event);
          if (event.type === "message_end") {
            this.updateUsage?.(accumulator.usage);
            this.options.onUsage?.(accumulator.progressResult().details);
          }
          if (event.type === "turn_end") this.options.onUpdate?.(accumulator.progressResult());
        });
        const finishTurn = session.agent.finishTurn;
        if (this.run.maxTurns !== undefined)
          session.agent.finishTurn = async (turn, signal) => {
            const decision = await finishTurn?.(turn, signal);
            return accumulator.usage.turns >= this.run.maxTurns!
              ? { action: "end" }
              : (decision ?? undefined);
          };
        let result: AgentToolResult<SubagentDetails>;
        try {
          this.record(this.run.task, "prompt", "coordinator");
          await session.prompt(this.run.task, { source: "extension" });
          await session.waitForIdle();
          result = this.activeSignal?.aborted
            ? accumulator.failure(new Error("Child cancelled."), true)
            : accumulator.success([...session.messages]);
        } catch (error) {
          await session.abort();
          result = accumulator.failure(
            error,
            this.controller?.signal.aborted === true || this.options.signal?.aborted === true,
          );
        } finally {
          unsubscribe();
          session.agent.finishTurn = finishTurn;
        }
        result.details.model = session.model ? `${session.model.provider}/${session.model.id}` : result.details.model;
        this.initialResult = structuredClone(result.details);
        return result;
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async input(text: string, mode: NativeInputMode): Promise<NativeInputResult> {
    if (this.state === "closing" || this.state === "closed")
      throw new Error(`Child is ${this.state}`);
    if (mode !== "prompt" && mode !== "steer" && mode !== "followUp")
      throw new Error("Invalid input mode");
    if (mode !== "prompt") {
      if (this.state !== "running" || !this.session?.isStreaming)
        throw new Error(`${mode} requires a streaming child`);
      const pending = this.context(async () => {
        this.record(text, mode, "human");
        return { outcome: await this.session![mode](text, undefined, { source: "interactive" }) };
      });
      this.pendingInputs.add(pending);
      try {
        return await pending;
      } finally {
        this.pendingInputs.delete(pending);
      }
    }
    return this.schedule(false, async () => {
      this.record(text, mode, "human");
      const usage = new SubagentRunAccumulator({ name: this.run.name, task: text, toolNames: this.session!.getActiveToolNames(), modelOverride: this.run.modelOverride, cwd: this.run.cwd, sessionId: this.id, sessionName: this.manager.getSessionName() ?? this.run.name }, () => false);
      const unsubscribe = this.session!.subscribe((event) => {
        if (event.type !== "message_end") return;
        usage.acceptEvent(event);
        this.updateUsage?.(usage.usage);
      });
      let outcome: NativeInputResult["outcome"] = "started";
      try {
        await this.session!.prompt(text, {
          source: "interactive",
          preflightResult: (value) => { outcome = value; },
        });
        await this.session!.waitForIdle();
        return { outcome };
      } finally {
        unsubscribe();
      }
    });
  }

  async cancel(): Promise<void> {
    this.controller?.abort();
    await this.context(async () => {
      await Promise.allSettled([this.session?.abort(), this.operation]);
      await Promise.allSettled([...this.pendingInputs]);
      // An asynchronous input hook may have queued after the first abort.
      await this.session?.abort();
    });
  }

  private teardownNative(): Promise<void> {
    return this.teardown ??= this.context(async () => {
      let startupRunner: ExtensionRunner | undefined;
      try {
        if (this.session) {
          await this.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
        } else if (this.startupServices) {
          const services = this.startupServices;
          const loaded = services.resourceLoader.getExtensions();
          // Until session construction succeeds, the loaded extensions still need
          // their native shutdown hooks. No second execution owner is created.
          startupRunner = new ExtensionRunner(loaded.extensions, loaded.runtime, this.run.cwd, this.manager, new ModelRegistry(services.modelRuntime));
          await startupRunner.emit({ type: "session_shutdown", reason: "quit" });
        }
      } finally {
        startupRunner?.invalidate();
        this.startupServices = undefined;
        this.session?.dispose();
        this.state = "closed";
      }
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.state === "closed") return this.teardown ?? Promise.resolve();
    this.state = "closing";
    this.closing = this.context(async () => {
      await this.cancel();
      await this.teardownNative();
    });
    return this.closing;
  }
}
