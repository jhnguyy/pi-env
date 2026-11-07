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
import * as ChildContext from "../_shared/child-context";
import type * as ExecutionTypes from "./execution-types";
import * as Resolver from "./resolver";
import * as Control from "./control";
import * as Usage from "./usage";
import type * as Types from "./types";

import * as ChildTypes from "./child-types";

export class NativeChildOwner implements ChildTypes.NativeChildSession {
  readonly id: string;
  readonly runId: string;
  private readonly agentDir = ChildContext.getChildContext()?.agentDir ?? getAgentDir();
  private session?: AgentSession;
  private startupServices?: AgentSessionServices;
  private activeSignal?: AbortSignal;
  // Owned by the admitted prompt operation (including its queued native turns).
  // Reset per prompt, never per hook: later turns must not erase an earlier failure.
  private selection: { checked: boolean; failure?: Error } = { checked: false };
  private state: ChildTypes.NativeChildSnapshot["state"] = ChildTypes.NativeChildState.Idle;
  private readonly inputs: ChildTypes.NativeChildInput[] = [];
  private initialResult?: Types.SubagentDetails;
  private operation?: Promise<unknown>;
  private controller?: AbortController;
  private closing?: Promise<void>;
  private teardown?: Promise<void>;
  private readonly pendingInputs = new Set<Promise<ChildTypes.NativeInputResult>>();
  private updateUsage?: (usage: Types.SubagentDetails["usage"]) => void;

  constructor(
    private readonly run: ExecutionTypes.ResolvedSubagentRun,
    private readonly ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
    private readonly manager: SessionManager,
    private readonly supervisor: Control.SubagentRunSupervisor,
    private readonly options: ExecutionTypes.RunSubagentOptions,
  ) {
    this.id = manager.getSessionId();
    this.runId = options.runId ?? randomUUID();
  }

  private context<T>(operation: () => T): T {
    return ChildContext.withChildContext({ cwd: this.run.cwd, agentDir: this.agentDir, id: this.id }, operation);
  }

  summary(): ChildTypes.NativeChildSummary {
    return {
      id: this.id, runId: this.runId, name: this.run.name, task: this.run.task, cwd: this.run.cwd,
      sessionFile: this.manager.getSessionFile(),
      model: this.session?.model ? `${this.session.model.provider}/${this.session.model.id}` : undefined,
      state: this.state,
    };
  }

  inspect(): ChildTypes.NativeChildSnapshot {
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
    const selectors = this.run.toolNames?.filter((name) => name.includes("*"));
    if (selectors?.length) throw new Error(`Child tools unavailable: use exact native names, not selectors: ${selectors.join(", ")}`);
    const trusted = Resolver.isProjectTrustedForCwd(this.ctx, this.run.cwd);
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
            pi.on("before_agent_start", (_event, ctx) => {
              // MCP's earlier native hook has completed its bounded direct-server wait.
              // Throwing here is swallowed by the SDK; latch and synchronously abort.
              if (!this.activeSignal?.aborted) {
                this.checkSelection();
                if (this.selection.failure) ctx.abort();
              }
            });
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
      const available = await services.modelRuntime.getAvailable();
      const matches = available.filter(
        (candidate) =>
          `${candidate.provider}/${candidate.id}` === requested || candidate.id === requested,
      );
      if (matches.length !== 1)
        throw new Error(
          `Child model unavailable or ambiguous: "${requested}". Available: ${available.map((candidate) => `${candidate.provider}/${candidate.id}`).join(", ")}`,
        );
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
  }

  private checkSelection(): void {
    this.selection.checked = true;
    if (this.run.toolNames === undefined || this.selection.failure) return;
    try {
      const available = new Set(this.session!.getAllTools().map((tool) => tool.name));
      const missing = this.run.toolNames.filter((name) => !available.has(name));
      if (missing.length) {
        this.selection.failure = new Error(
          `Child tools unavailable: ${missing.join(", ")} (not available at native preflight; direct MCP startup wait is bounded)`,
        );
      } else {
        this.session!.setActiveToolsByName([...this.run.toolNames]);
      }
    } catch (cause) {
      this.selection.failure = cause instanceof Error ? cause : new Error("Child tool selection failed.", { cause });
    }
  }

  private finishSelection(): void {
    // Cancellation wins, including when it arrives during native MCP preflight.
    if (this.activeSignal?.aborted) return;
    // Handled input has no before_agent_start. Check only the known catalog;
    // do not start dummy inference to force MCP discovery.
    if (!this.selection.checked) this.checkSelection();
    if (this.selection.failure) throw this.selection.failure;
  }

  private record(text: string, mode: ChildTypes.NativeInputMode, source: ChildTypes.NativeChildInput["source"]): void {
    const entry = { text, mode, source, at: new Date().toISOString() };
    this.inputs.push(entry);
    this.manager.appendCustomEntry("subagent-input", entry);
  }

  private schedule<T>(initial: boolean, operation: () => Promise<T>): Promise<T> {
    if (this.state !== ChildTypes.NativeChildState.Idle) return Promise.reject(new Error(`Child is ${this.state}`));
    // Reserve before asynchronous admission: a second idle prompt cannot become a second writer.
    this.state = ChildTypes.NativeChildState.Queued;
    const controller = (this.controller = new AbortController());
    const signal =
      initial && this.options.signal
        ? AbortSignal.any([controller.signal, this.options.signal])
        : controller.signal;
    const pending = this.context(async () => {
      const lease = await this.supervisor.acquire({
        runId: initial ? this.runId : `${this.runId}:human:${randomUUID()}`,
        cwd: this.run.cwd,
        workspaceAccess: Control.WorkspaceAccess.Write,
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
        if (lease.signal.aborted || this.state === ChildTypes.NativeChildState.Closing) throw new Error("Child cancelled");
        this.selection = { checked: false };
        this.state = ChildTypes.NativeChildState.Running;
        return await operation();
      } catch (error) {
        if (initial) {
          this.state = ChildTypes.NativeChildState.Closing;
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
      if (this.state !== ChildTypes.NativeChildState.Closing && this.state !== ChildTypes.NativeChildState.Closed) this.state = ChildTypes.NativeChildState.Idle;
      this.supervisor.pruneChildren();
    });
  }

  async runInitial(): Promise<AgentToolResult<Types.SubagentDetails>> {
    try {
      return await this.schedule(true, async () => {
        const session = this.session!;
        const accumulator = new Usage.SubagentRunAccumulator(
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
        let result: AgentToolResult<Types.SubagentDetails>;
        try {
          this.record(this.run.task, ChildTypes.NativeInputMode.Prompt, ChildTypes.NativeInputSource.Coordinator);
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
        this.finishSelection();
        result.details.toolNames = session.getActiveToolNames();
        result.details.model = session.model ? `${session.model.provider}/${session.model.id}` : result.details.model;
        this.initialResult = structuredClone(result.details);
        return result;
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async input(text: string, mode: ChildTypes.NativeInputMode): Promise<ChildTypes.NativeInputResult> {
    if (this.state === ChildTypes.NativeChildState.Closing || this.state === ChildTypes.NativeChildState.Closed)
      throw new Error(`Child is ${this.state}`);
    if (mode !== ChildTypes.NativeInputMode.Prompt && mode !== ChildTypes.NativeInputMode.Steer && mode !== ChildTypes.NativeInputMode.FollowUp)
      throw new Error("Invalid input mode");
    if (mode !== ChildTypes.NativeInputMode.Prompt) {
      if (this.state !== ChildTypes.NativeChildState.Running || !this.session?.isStreaming)
        throw new Error(`${mode} requires a streaming child`);
      const pending = this.context(async () => {
        this.record(text, mode, ChildTypes.NativeInputSource.Human);
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
      this.record(text, mode, ChildTypes.NativeInputSource.Human);
      const usage = new Usage.SubagentRunAccumulator({ name: this.run.name, task: text, toolNames: this.session!.getActiveToolNames(), modelOverride: this.run.modelOverride, cwd: this.run.cwd, sessionId: this.id, sessionName: this.manager.getSessionName() ?? this.run.name }, () => false);
      const unsubscribe = this.session!.subscribe((event) => {
        if (event.type !== "message_end") return;
        usage.acceptEvent(event);
        this.updateUsage?.(usage.usage);
      });
      let outcome: ChildTypes.NativeInputResult["outcome"] = ChildTypes.NativeInputOutcome.Started;
      try {
        await this.session!.prompt(text, {
          source: "interactive",
          preflightResult: (value) => { outcome = value; },
        });
        await this.session!.waitForIdle();
        this.finishSelection();
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
        this.state = ChildTypes.NativeChildState.Closed;
      }
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.state === ChildTypes.NativeChildState.Closed) return this.teardown ?? Promise.resolve();
    this.state = ChildTypes.NativeChildState.Closing;
    this.closing = this.context(async () => {
      await this.cancel();
      await this.teardownNative();
    });
    return this.closing;
  }
}
