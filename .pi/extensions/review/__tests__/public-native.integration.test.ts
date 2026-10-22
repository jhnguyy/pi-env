import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { REVIEW_ENTRY_TYPE, type ReviewState } from "../core";
import initReview from "../index";
import { setManagedGitExecForTests } from "../snapshot";
import initSubagent from "../../subagent/index";
import { getSubagentRunSupervisor } from "../../subagent/control";
import {
  listenForDagRuntimeService,
  type ActiveDagRuntimeService,
} from "../../_shared/dag-runtime-service";
import { git, reviewRepo } from "./fixtures/review-repo";
import {
  ParentProvider,
  ReviewProvider,
  SignedOutProvider,
} from "./fixtures/native-review-provider";

it("completes and reuses a scoped public review through real native children", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-native-review-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => {
    vi.unstubAllEnvs();
  });
  cleanup.defer(() => setManagedGitExecForTests());
  cleanup.defer(() => rm(root, { recursive: true, force: true }));
  const repo = reviewRepo("a.ts", "export const value = 1;\n");
  const agentDir = join(root, "agent");
  const cwd = join(root, "parent");
  await mkdir(agentDir);
  await mkdir(cwd);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [ParentProvider]: { apiKey: "synthetic-not-a-secret" },
        [ReviewProvider]: { apiKey: "synthetic-not-a-secret" },
      },
    }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: [fileURLToPath(new URL("./fixtures/native-review-provider.ts", import.meta.url))],
      defaultProvider: ParentProvider,
      defaultModel: "faux-1",
      defaultTools: ["read"],
      retry: { enabled: false },
    }),
  );
  let runtime: ActiveDagRuntimeService | undefined;
  const observeRuntime = (pi: ExtensionAPI) => {
    cleanup.defer(
      listenForDagRuntimeService(pi, (registration) => {
        runtime = registration.service;
      }),
    );
  };
  const reviewWithLocalRemote = (pi: ExtensionAPI) => initReview({ ...pi, exec: repo.exec });
  setManagedGitExecForTests(repo.localExec);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
    resourceLoaderReloadOptions: { resolveProjectTrust: async () => true },
    resourceLoaderOptions: {
      extensionFactories: [observeRuntime, initSubagent, reviewWithLocalRemote],
    },
  });
  const parentModel = services.modelRuntime.getModel(ParentProvider, "faux-1")!;
  const reviewModel = services.modelRuntime.getModel(ReviewProvider, "faux-1")!;
  const signedOutModel = services.modelRuntime.getModel(SignedOutProvider, "faux-1")!;
  const availableProviders = (await services.modelRuntime.getAvailable()).map(
    (model) => model.provider,
  );
  expect(availableProviders).toEqual(expect.arrayContaining([ParentProvider, ReviewProvider]));
  expect(availableProviders).not.toContain(SignedOutProvider);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.create(cwd, join(root, "sessions")),
    model: parentModel,
    scopedModels: [{ model: reviewModel }, { model: signedOutModel }],
    tools: ["review"],
  });
  cleanup.defer(() => session.dispose());
  cleanup.defer(async () => {
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
  });
  cleanup.defer(() => session.abort());
  await session.bindExtensions({ mode: "print" });
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
    void session.abort();
  }, 20_000);
  cleanup.defer(() => clearTimeout(timeout));
  const latestState = () => {
    const entries = session.sessionManager.getBranch();
    const entry = [...entries]
      .reverse()
      .find((item) => item.type === "custom" && item.customType === REVIEW_ENTRY_TYPE);
    if (entry?.type !== "custom") throw new Error("Public review did not persist state");
    return (entry.data as { state: ReviewState }).state;
  };
  await session.prompt("Create the fixture pull request review. Parent-only marker.");
  controller.signal.throwIfAborted();
  const state = latestState();
  expect(state.dag?.status, JSON.stringify(state)).toBe("succeeded");
  cleanup.defer(async () => {
    await runtime?.closeChildren?.(state.dag!.runId);
  });
  expect(state.result?.provenance?.status).toBe("accepted");
  expect(state.result?.coverage?.status).toBe("complete");
  expect(state.result?.findings).toHaveLength(1);
  expect(state.result?.findings[0]).toMatchObject({
    anchorValid: true,
    sourceReviewers: ["correctness"],
  });
  expect(Object.values(state.roleAssignments!).map((role) => role.model)).toEqual(
    Array.from({ length: 8 }, () => `${ReviewProvider}/faux-1`),
  );
  expect(git(state.snapshot.worktree, "rev-parse", "HEAD")).toBe(repo.metadata.headOid);
  expect(state.snapshot.metadata.changedFiles).toEqual([{ path: "a.ts" }]);
  const persisted = await readFile(join(state.snapshot.artifactDir, "state.json"), "utf8");
  expect(JSON.parse(persisted)).toEqual(state);
  const children = getSubagentRunSupervisor(session.sessionId)!.children;
  expect(children.size).toBe(8);
  for (const child of children.values()) {
    const inspected = child.inspect();
    expect(inspected.model).toBe(`${ReviewProvider}/faux-1`);
    expect(JSON.stringify(inspected.messages)).not.toContain("Parent-only marker.");
    expect(await readFile(child.summary().sessionFile!, "utf8")).toContain(
      "review-fixture-request",
    );
    if (
      inspected.name.startsWith("review-pr-") &&
      !/reading-plan|synthesis/u.test(inspected.name)
    ) {
      expect(inspected.activeTools).toEqual([]);
      expect(inspected.callableTools).toEqual([]);
    }
  }
  expect(session.getActiveToolNames()).toEqual(["review"]);
  expect(session.model?.provider).toBe(ParentProvider);
  expect(state.posts).toEqual([]);
  await session.prompt("Create the same fixture review again.");
  controller.signal.throwIfAborted();
  expect(latestState()).toEqual(state);
  expect(children.size).toBe(8);
  expect(await readFile(join(state.snapshot.artifactDir, "state.json"), "utf8")).toBe(persisted);
  const results = session.messages.flatMap((message) =>
    message.role === "toolResult" && message.toolName === "review" ? [message] : [],
  );
  expect(results).toHaveLength(2);
  expect(results.every((result) => !result.isError)).toBe(true);
  expect(JSON.stringify(results)).toContain("Native review retained one actionable finding.");
  expect(JSON.stringify(results.at(-1))).toContain('"reused":true');
  console.info(
    JSON.stringify({
      input:
        "Public create; local Git; real native children; disk-loaded scripted provider; one scoped model",
      expected:
        "complete coverage; accepted provenance; eight scoped children; persisted idempotent reuse",
      actual: {
        status: state.dag!.status,
        findings: state.result!.findings.length,
        children: children.size,
      },
      reproduce:
        "nub run test:vitest .pi/extensions/review/__tests__/public-native.integration.test.ts",
    }),
  );
});
