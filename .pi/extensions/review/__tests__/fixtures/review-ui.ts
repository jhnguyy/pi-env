import { onTestFinished, vi } from "vitest";
import { REVIEW_ENTRY_TYPE, type ReviewState } from "../../core";
import reviewExtension from "../../index";

export function useReviewAgentDir(root: string): void {
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
}

export function reviewEntry(state: ReviewState): unknown {
  return {
    type: "custom",
    customType: REVIEW_ENTRY_TYPE,
    data: { reviewId: state.snapshot.id, state },
  };
}

export function persistedReviewEntries(
  entries: readonly unknown[],
  appended: readonly any[],
): unknown[] {
  return [
    ...entries,
    ...appended.map((data) => ({ type: "custom", customType: REVIEW_ENTRY_TYPE, data })),
  ];
}

type Reply = (args: string[], options: { signal?: AbortSignal }) => unknown | Promise<unknown>;

export function githubStub(replies: { head?: Reply; list?: Reply; post?: Reply } = {}) {
  return async (_cmd: string, args: string[], options: { signal?: AbortSignal } = {}) => {
    if (args[0] === "pr")
      return (replies.head ?? (() => ({ code: 0, stdout: "head\n", stderr: "" })))(args, options);
    if (args.includes("--method"))
      return (replies.list ?? (() => ({ code: 0, stdout: "[]", stderr: "" })))(args, options);
    if (args[0] === "api" && args[1] === "-X")
      return (replies.post ?? (() => ({ code: 0, stdout: "{}", stderr: "" })))(args, options);
    return { code: 1, stdout: "", stderr: "bad" };
  };
}

export function registeredReview(options: {
  root: string;
  sessionDir?: string;
  sessionId?: string;
  entries: readonly unknown[];
  exec?: (...args: any[]) => any;
  append?: (type: string, data: any) => void;
}) {
  const commands: Record<string, any> = {};
  const handlers: Record<string, any> = {};
  const appended: any[] = [];
  let githubCalls = 0;
  useReviewAgentDir(options.root);
  const pi = {
    events: { on: () => () => {} },
    registerTool() {},
    registerCommand(name: string, command: any) {
      commands[name] = command.handler;
    },
    on(name: string, handler: any) {
      handlers[name] = handler;
    },
    appendEntry(type: string, data: any) {
      const saved = structuredClone(data);
      appended.push(saved);
      options.append?.(type, saved);
    },
    exec: async (...args: any[]) => {
      githubCalls++;
      if (options.exec) return options.exec(...args);
      throw new Error("walkthrough must not post or call GitHub");
    },
  };
  reviewExtension(pi as never);
  onTestFinished(() => handlers.session_shutdown?.());
  const session = (entries = options.entries, id = options.sessionId ?? "session") => ({
    cwd: options.root,
    hasUI: true,
    sessionManager: {
      getSessionId: () => id,
      getSessionDir: () => options.sessionDir ?? options.root,
      getBranch: () => entries,
    },
    modelRegistry: { getAvailable: () => [] },
  });
  return {
    command: commands.review,
    handlers,
    appended,
    session,
    githubCalls: () => githubCalls,
  };
}

export function reviewContext(root: string, hasUI = true) {
  const notes: string[] = [];
  return {
    notes,
    ctx: {
      hasUI,
      cwd: root,
      ui: {
        notify: (message: string) => notes.push(message),
        confirm: async () => true,
        select: async () => undefined,
        editor: async () => undefined,
      },
    },
  };
}
