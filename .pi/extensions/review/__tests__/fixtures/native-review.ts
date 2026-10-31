import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { vi, type TestContext } from "vitest";
import { REVIEW_ENTRY_TYPE, type ReviewState } from "../../core";
import initReview from "../../index";
import initSubagent from "../../../subagent/index";
import { connectSubagentService, type SubagentServiceConnection } from "../../../subagent/service-host";
import { RegisteredServiceFixture } from "../../../subagent/__tests__/registered-service.fixture";
import { git, reviewRepo } from "./review-repo";
import {
  ParentProvider,
  ReviewProvider,
  SecondReviewProvider,
  type NativeReviewProviderOptions,
} from "./native-review-provider";

interface NativeReviewOptions {
  readonly scopedProviders: readonly string[];
  readonly roleModels?: Readonly<Record<string, string>>;
  readonly provider?: NativeReviewProviderOptions;
  readonly expected: string;
}

/** Own native sessions and their synthetic evidence, not scenario assertions or DAG execution. */
export function createNativeReviewFixture(
  context: TestContext,
  options: NativeReviewOptions,
  dependencies: {
    readonly removeDirectory?: typeof rm;
    readonly writeEvidence?: typeof writeFile;
  } = {},
) {
  const { removeDirectory = rm, writeEvidence = writeFile } = dependencies;
  // reviewRepo's teardown is registered first, so sessions settle before its Git directory is removed.
  const repo = reviewRepo("a.ts", "export const value = 1;\n");
  const root = mkdtempSync(join(tmpdir(), "public-native-review-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "parent");
  const service = new RegisteredServiceFixture(agentDir);
  let connection: SubagentServiceConnection | undefined;
  let session: AgentSession | undefined;
  let starting: Promise<void> | undefined;
  let pendingAbort: Promise<void> | undefined;
  let availableModels: string[] = [];
  const failures: unknown[] = [];
  const settle = async (operation: () => unknown) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  const requestAbort = () => {
    pendingAbort = session?.abort();
    void pendingAbort?.catch((error) => {
      failures.push(error);
    });
  };
  context.signal.addEventListener("abort", requestAbort);
  context.onTestFinished(async () => {
    // Startup may still be settling after a runner timeout. Do not delete resources beneath it.
    await starting?.catch(() => {});
    await pendingAbort?.catch(() => {});
    let children: { name: string; model: string | undefined; state: string }[] = [];
    await settle(async () => {
      children = (await childSnapshots()).map(({ name, model, state }) => ({ name, model, state }));
    });
    await settle(() => session?.abort());
    if (connection) {
      const snapshot = connection.view.snapshot.value;
      const runIds = new Set([
        ...snapshot.children.map((child) => child.runId),
        ...snapshot.operations.map((operation) => operation.runId),
      ]);
      for (const runId of runIds)
        await settle(() => connection!.view.closeRun({ runId }));
    }
    await settle(() =>
      session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }),
    );
    await settle(() => session?.dispose());
    await settle(() => connection?.close());
    await settle(() => service.close());
    context.signal.removeEventListener("abort", requestAbort);
    vi.unstubAllEnvs();
    const testFailed = context.task.result?.state === "fail";
    if (!testFailed && failures.length === 0)
      await settle(() => removeDirectory(root, { recursive: true, force: true }));
    if (testFailed || failures.length > 0) {
      await settle(() => mkdir(root, { recursive: true }));
      await settle(() => cp(repo.root, join(root, "git-fixture"), { recursive: true }));
    }
    const evidence = () => ({
      scenario: context.task.name,
      input: {
        scope: options.scopedProviders,
        roleModels: options.roleModels,
        provider: options.provider,
      },
      expected: options.expected,
      actual: { state: latestState(), children },
      verdict: testFailed || failures.length > 0 ? "failed" : "passed",
      aborted: context.signal.aborted,
      errors: context.task.result?.errors?.map((error) => error.message),
      cleanupErrors: failures.map((error) => (error instanceof Error ? error.message : error)),
      retainedEvidence: testFailed || failures.length > 0 ? root : undefined,
      reproduce:
        "nub run test:integration .pi/extensions/review/__tests__/public-native.integration.test.ts",
    });
    if (testFailed || failures.length > 0)
      await settle(() =>
        writeEvidence(join(root, "evidence.json"), JSON.stringify(evidence(), null, 2)),
      );
    const finalEvidence = evidence();
    console.info(
      JSON.stringify({
        ...finalEvidence,
        actual: {
          status:
            finalEvidence.actual.state?.dag?.status ??
            finalEvidence.actual.state?.preparation?.stage,
          error:
            finalEvidence.actual.state?.dag?.error ??
            finalEvidence.actual.state?.preparation?.message,
          children: finalEvidence.actual.children,
        },
      }),
    );
    if (failures.length)
      throw new AggregateError(failures, `Native review fixture cleanup failed. Evidence: ${root}`);
  });

  function requireSession(): AgentSession {
    if (!session) throw new Error("Start the native review fixture before using it");
    return session;
  }
  function latestState(): ReviewState | undefined {
    const entry = [...(session?.sessionManager.getBranch() ?? [])]
      .reverse()
      .find((item) => item.type === "custom" && item.customType === REVIEW_ENTRY_TYPE);
    return entry?.type === "custom" ? (entry.data as { state: ReviewState }).state : undefined;
  }
  async function childSnapshots() {
    if (!connection) return [];
    return Promise.all(connection.view.snapshot.value.children.map(async (child) => {
      const inspection = await connection!.inspect(child.childId);
      try {
        await inspection.refresh({});
        const snapshot = inspection.snapshot.value;
        if (!snapshot) throw new Error(`Missing native child inspection: ${child.childId}`);
        return snapshot;
      } finally {
        inspection.release();
      }
    }));
  }
  async function start() {
    context.signal.throwIfAborted();
    await mkdir(agentDir);
    await mkdir(cwd);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const providerPath = fileURLToPath(new URL("./native-review-provider.ts", import.meta.url));
    const extension = join(agentDir, "provider.mjs");
    await writeFile(
      extension,
      `import provider from ${JSON.stringify(providerPath)};\nexport default pi => provider(pi, ${JSON.stringify(options.provider ?? {})});\n`,
    );
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: Object.fromEntries(
          [ParentProvider, ReviewProvider, SecondReviewProvider].map((provider) => [
            provider,
            { apiKey: "synthetic-not-a-secret" },
          ]),
        ),
      }),
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        extensions: [extension],
        defaultProvider: ParentProvider,
        defaultModel: "faux-1",
        defaultTools: ["read"],
        retry: { enabled: false },
        prReview: { roleModels: options.roleModels ?? {} },
      }),
    );
    const gitConfig = join(root, "gitconfig");
    git(
      repo.root,
      "config",
      "--file",
      gitConfig,
      `url.file://${repo.origin}.insteadOf`,
      "https://github.com/acme/widgets.git",
    );
    vi.stubEnv("GIT_CONFIG_GLOBAL", gitConfig);
    const reviewWithLocalRemote = (pi: ExtensionAPI) =>
      initReview({
        ...pi,
        exec: (command, args, execOptions) =>
          command === "gh"
            ? repo.exec(command, args, execOptions)
            : pi.exec(command, args, execOptions),
      });
    await service.start();
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntimeSignal: context.signal,
      settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => true },
      resourceLoaderOptions: { extensionFactories: [initSubagent, reviewWithLocalRemote] },
    });
    const model = (provider: string) => {
      const resolved = services.modelRuntime.getModel(provider, "faux-1");
      if (!resolved) throw new Error(`Fixture provider has no model: ${provider}`);
      return resolved;
    };
    availableModels = (await services.modelRuntime.getAvailable()).map(
      (candidate) => `${candidate.provider}/${candidate.id}`,
    );
    ({ session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.create(cwd, join(root, "sessions")),
      model: model(ParentProvider),
      scopedModels: options.scopedProviders.map((provider) => ({ model: model(provider) })),
      tools: ["review"],
    }));
    context.signal.throwIfAborted();
    connection = await connectSubagentService(session.sessionId, agentDir);
    await session.bindExtensions({
      mode: "print",
      onError: (error) => {
        failures.push(error);
      },
    });
  }
  return {
    start: () => (starting ??= start()),
    headOid: repo.metadata.headOid,
    state: () => {
      const state = latestState();
      if (!state) throw new Error("Public create did not persist review state");
      return state;
    },
    children: childSnapshots,
    availableModels: () => availableModels,
    readPersistedState: () => {
      const state = latestState();
      if (!state) throw new Error("No review state to read");
      return readFile(join(state.snapshot.artifactDir, "state.json"), "utf8");
    },
    async create(prompt = "Create the fixture pull request review. Parent-only marker.") {
      const parent = requireSession();
      const before = parent.messages.length;
      await parent.prompt(prompt);
      context.signal.throwIfAborted();
      const results = parent.messages
        .slice(before)
        .flatMap((message) =>
          message.role === "toolResult" && message.toolName === "review" ? [message] : [],
        );
      if (results.length !== 1)
        throw new Error("Public create did not return exactly one review result");
      return results[0];
    },
    reload: () => requireSession().reload(),
    parentConfiguration: () => {
      const parent = requireSession();
      return {
        model: parent.model && `${parent.model.provider}/${parent.model.id}`,
        tools: parent.getActiveToolNames(),
      };
    },
  };
}
