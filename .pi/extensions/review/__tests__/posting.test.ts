import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ReviewEvent, type ReviewState } from "../core";
import { postReview, restore } from "../index";
import {
  githubStub,
  registeredReview,
  reviewContext,
  reviewEntry,
  useReviewAgentDir,
} from "./fixtures/review-ui";

function root() {
  const dir = mkdtempSync(join(tmpdir(), "pi-pr-review-agent-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  useReviewAgentDir(dir);
  return dir;
}
function state(dir = root()): ReviewState {
  const base = `${dir}/pr-review`;
  mkdirSync(`${base}/artifacts/r`, { recursive: true });
  return {
    snapshot: {
      id: "r",
      artifactDir: `${base}/artifacts/r`,
      worktree: `${base}/worktrees/r`,
      diffPath: `${base}/artifacts/r/diff.patch`,
      diffHash: "h",
      createdAt: "now",
      metadata: {
        owner: "o",
        repo: "repo",
        number: 2,
        url: "https://github.com/o/repo/pull/2",
        baseOid: "b",
        headOid: "head",
        changedFiles: [{ path: "a.ts" }],
      },
    },
    plan: {
      goal: "g",
      goalAssessment: "a",
      risk: "r",
      riskReasons: [],
      cohorts: [{ label: "main", purpose: "review changed file", paths: ["a.ts"] }],
      files: [{ path: "a.ts", attention: "normal", role: "changed file" }],
      evidence: [{ kind: "file", path: "a.ts", startLine: 1, endLine: 1, purpose: "review" }],
    },
    result: {
      verdict: "v",
      findings: [
        {
          id: "F1",
          severity: "serious",
          impact: "low",
          file: "a.ts",
          side: "RIGHT",
          line: 3,
          problem: "p",
          consequence: "c",
          suggestedFix: "f",
          selected: true,
          anchorValid: true,
        },
        {
          id: "F2",
          severity: "serious",
          impact: "low",
          problem: "u",
          consequence: "c",
          suggestedFix: "f",
          selected: true,
          anchorValid: false,
        },
      ],
    },
    dag: {
      runId: "run",
      status: "succeeded",
      submitted: true,
      rawResultReferences: [],
    },
    selectedFindingIds: ["F1", "F2"],
    posts: [],
  };
}
describe("review pull request posting", () => {
  it("uses GET pagination, persists pending before POST, and reuses uncertain attempt on retry", async () => {
    const s = state();
    restore({ sessionManager: { getBranch: () => [reviewEntry(s)] } } as any);
    const getCalls: string[][] = [];
    const postCalls: string[][] = [];
    const appended: any[] = [];
    let persistedMarker = "";
    const pi = {
      appendEntry(_type: string, data: any) {
        appended.push(data);
        persistedMarker = data.state.posts[0]?.marker ?? persistedMarker;
      },
      exec: githubStub({
        list: (args) => {
          getCalls.push(args);
          return {
            code: 0,
            stdout:
              getCalls.length >= 2 && persistedMarker
                ? JSON.stringify([{ id: "remote1", body: persistedMarker }])
                : "[]",
            stderr: "",
          };
        },
        post: (args) => {
          postCalls.push(args);
          return { code: 1, stdout: "", stderr: "lost" };
        },
      }),
    };
    const confirms: any[] = [];
    const ctx = {
      cwd: "/tmp",
      ui: {
        confirm: async (title: string, message: string) => {
          confirms.push([title, message]);
          return true;
        },
      },
    };
    expect(await postReview(pi as any, ctx as any, ReviewEvent.Comment)).toContain("uncertain");
    expect(appended.some((a) => a.state.posts[0]?.status === "pending")).toBe(true);
    expect(await postReview(pi as any, ctx as any, ReviewEvent.Comment)).toContain(
      "not posting duplicate",
    );
    expect(postCalls).toHaveLength(1);
    expect(getCalls.filter((args) => args.includes("GET")).length).toBeGreaterThan(0);
    expect(confirms).toHaveLength(1);
    expect(confirms[0][1]).toContain("Preface preview:\n(none)");
    expect(confirms[0][1]).toContain("Coverage: complete.");
    expect(confirms[0][1]).not.toContain("WARNING: degraded coverage");
    expect(persistedMarker).toBe(
      "<!-- pi-env-pr-review:r:" + appended[0].state.posts[0].id + " -->",
    );
  });

  it("discloses degraded coverage and selections only at cancellable post confirmation", async () => {
    const degraded = state();
    degraded.dag = {
      ...degraded.dag!,
      status: "degraded",
      failedNodes: ["review-security"],
      evidenceCoverage: {
        digest: "d".repeat(64),
        uniqueBytes: 1,
        dossierBytes: 1,
        chunks: 1,
        omissions: ["b.ts hunk"],
      },
    };
    degraded.result!.coverage = {
      status: "degraded",
      succeeded: ["correctness"],
      failed: ["security"],
      malformed: [],
    };
    restore({ sessionManager: { getBranch: () => [reviewEntry(degraded)] } } as any);
    let posted = false;
    let confirmation = "";
    const pi = {
      appendEntry() {},
      exec: githubStub({
        post: () => {
          posted = true;
          return { code: 0, stdout: "{}", stderr: "" };
        },
      }),
    };
    const result = await postReview(
      pi as any,
      {
        cwd: "/tmp",
        ui: {
          confirm: async (_title: string, message: string) => {
            confirmation = message;
            return false;
          },
        },
      } as any,
      ReviewEvent.Comment,
    );
    expect(result).toBe("Posting cancelled.");
    expect(confirmation).toContain("WARNING: degraded coverage");
    expect(confirmation).toContain("Selected (2): F1, F2");
    expect(confirmation).toContain("Failed: security");
    expect(posted).toBe(false);
  });

  it("does not repost while an earlier attempt remains uncertain", async () => {
    restore({ sessionManager: { getBranch: () => [reviewEntry(state())] } } as any);
    let posts = 0;
    const pi = {
      appendEntry() {},
      exec: githubStub({
        post: () => {
          posts += 1;
          return { code: 1, stdout: "", stderr: "lost" };
        },
      }),
    };
    const ctx = { cwd: "/tmp", ui: { confirm: async () => true } };
    expect(await postReview(pi as any, ctx as any, ReviewEvent.Comment)).toContain("uncertain");
    expect(await postReview(pi as any, ctx as any, ReviewEvent.Comment)).toContain(
      "still uncertain",
    );
    expect(posts).toBe(1);
  });

  it("serializes concurrent identical posts and posts once", async () => {
    const s = { ...state(), preface: "hello\n".repeat(200) };
    restore({ sessionManager: { getBranch: () => [reviewEntry(s)] } } as any);
    let posts = 0;
    const confirms: any[] = [];
    let releasePost!: () => void;
    const postEntered = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const pi = {
      appendEntry(_type: string, data: any) {
        restore({ sessionManager: { getBranch: () => [reviewEntry(data.state)] } } as any);
      },
      exec: githubStub({
        post: async () => {
          posts += 1;
          if (posts === 1) await postEntered;
          return { code: 0, stdout: JSON.stringify({ id: `remote${posts}` }), stderr: "" };
        },
      }),
    };
    const ctx = {
      cwd: "/tmp",
      ui: {
        confirm: async (_title: string, message: string) => {
          confirms.push(message);
          return true;
        },
      },
    };
    const first = postReview(pi as any, ctx as any, ReviewEvent.Comment);
    const second = postReview(pi as any, ctx as any, ReviewEvent.Comment);
    await Promise.resolve();
    releasePost();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "Review posted.",
      "Review already posted (remote1).",
    ]);
    expect(posts).toBe(1);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain("Preface preview:");
    expect(confirms[0].length).toBeLessThan(700);
  });

  it("blocks incomplete reviews before posting", async () => {
    const incomplete = { ...state(), result: undefined };
    restore({ sessionManager: { getBranch: () => [reviewEntry(incomplete)] } } as any);
    const pi = { appendEntry() {}, exec: githubStub() } as any;
    const ctx = { cwd: "/tmp", ui: { confirm: async () => true } } as any;
    await expect(postReview(pi, ctx, ReviewEvent.Approve)).resolves.toContain("not complete");
  });

  it.each(["preflight", "confirmation", "confirmed preflight"])(
    "refuses changed content during %s before proceeding",
    async (stage) => {
      const changed = state();
      restore({ sessionManager: { getBranch: () => [reviewEntry(changed)] } } as any);
      const changeContent = () =>
        restore({
          sessionManager: {
            getBranch: () => [reviewEntry({ ...changed, preface: "Updated human preface" })],
          },
        } as any);
      let posts = 0;
      let headChecks = 0;
      let confirmations = 0;
      const pi = {
        appendEntry() {
          throw new Error("Changed content must not create a posting attempt.");
        },
        exec: githubStub({
          head: () => {
            headChecks += 1;
            if (
              (stage === "preflight" && headChecks === 1) ||
              (stage === "confirmed preflight" && headChecks === 2)
            )
              changeContent();
            return { code: 0, stdout: "head\n", stderr: "" };
          },
          post: () => {
            posts += 1;
            return { code: 0, stdout: "{}", stderr: "" };
          },
        }),
      };
      const ctx = {
        cwd: "/tmp",
        ui: {
          confirm: async () => {
            confirmations += 1;
            if (stage === "confirmation") changeContent();
            return true;
          },
        },
      };
      await expect(postReview(pi as any, ctx as any, ReviewEvent.Comment)).resolves.toContain(
        "changed",
      );
      expect(posts).toBe(0);
      expect(confirmations).toBe(stage === "preflight" ? 0 : 1);
    },
  );

  it("blocks posting before confirmation when the remote head is stale", async () => {
    const s = state();
    restore({ sessionManager: { getBranch: () => [reviewEntry(s)] } } as any);
    let confirmed = false;
    let posted = false;
    const pi = {
      appendEntry() {},
      exec: githubStub({
        head: () => ({ code: 0, stdout: "new-head\n", stderr: "" }),
        post: () => {
          posted = true;
          return { code: 0, stdout: "{}", stderr: "" };
        },
      }),
    } as any;
    const ctx = {
      ui: {
        confirm: async () => {
          confirmed = true;
          return true;
        },
      },
    } as any;
    await expect(postReview(pi, ctx, ReviewEvent.Comment)).resolves.toMatch(/stale/);
    expect(confirmed).toBe(false);
    expect(posted).toBe(false);
  });

  it("posts the explicit review ID with only human-selected decisions through the existing authority path", async () => {
    const older = state();
    older.snapshot.id = "older";
    older.decisions = {
      F1: { status: "selected", at: "now" },
      F2: { status: "rejected", at: "now" },
    };
    older.selectedFindingIds = ["F1"];
    const newer = structuredClone(older);
    newer.snapshot.id = "newer";
    newer.snapshot.metadata.headOid = "newer-head";
    newer.decisions = { F2: { status: "selected", at: "now" } };
    newer.selectedFindingIds = ["F2"];
    let payload: { comments: Array<{ body: string }>; body: string } | undefined;
    const view = reviewContext(root());
    const h = registeredReview({
      root: view.ctx.cwd,
      entries: [reviewEntry(older), reviewEntry(newer)],
      exec: githubStub({
        post: (args) => {
          payload = JSON.parse(readFileSync(args.at(-1)!, "utf8"));
          return { code: 0, stdout: JSON.stringify({ id: "remote" }), stderr: "" };
        },
      }),
    });
    const runtime = { ...h.session(), ui: view.ctx.ui };
    h.handlers.session_start({}, runtime);
    await h.command("pr post older comment", runtime);
    expect(view.notes.at(-1)).toBe("Review posted.");
    expect(payload?.comments).toHaveLength(1);
    expect(payload?.comments[0]?.body).toContain("p");
    expect(payload?.body).not.toContain("u");
  });

  it("registered post rejects a session switch while confirmation is open", async () => {
    const original = state();
    const replacement = { ...structuredClone(original), preface: "replacement" };
    const view = reviewContext(root());
    let posts = 0;
    let releaseConfirm!: (confirmed: boolean) => void;
    let markConfirmEntered!: () => void;
    const confirmEntered = new Promise<void>((resolve) => {
      markConfirmEntered = resolve;
    });
    const confirmation = new Promise<boolean>((resolve) => {
      releaseConfirm = resolve;
    });
    const h = registeredReview({
      root: view.ctx.cwd,
      entries: [reviewEntry(original)],
      append: () => {
        throw new Error("stale confirmation must not append");
      },
      exec: githubStub({ post: () => ({ code: 0, stdout: `${++posts}`, stderr: "" }) }),
    });
    const runtime = (sessionId: string, review: ReviewState, confirm = async () => true) => ({
      ...h.session([reviewEntry(review)], sessionId),
      ui: { ...view.ctx.ui, confirm },
    });
    const originalRuntime = runtime("original", original, async () => {
      markConfirmEntered();
      return confirmation;
    });
    h.handlers.session_start({}, originalRuntime);
    const posting = h.command("pr post r comment", originalRuntime);
    await confirmEntered;
    h.handlers.session_tree({}, runtime("replacement", replacement));
    releaseConfirm(true);
    await posting;
    expect(posts).toBe(0);
    expect(view.notes.at(-1)).toMatch(/session changed|interrupted/i);
  });

  it("journals before submission and never writes an in-flight result into a replacement session", async () => {
    const original = state();
    const replacement = { ...structuredClone(original), preface: "replacement" };
    const view = reviewContext(root());
    const appended: Array<{ session: string; state: ReviewState }> = [];
    let activeSession = "original";
    let posts = 0;
    let releasePost!: () => void;
    const postBlocked = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    let rotateOnPending = true;
    let replacementRuntime: any;
    const h = registeredReview({
      root: view.ctx.cwd,
      entries: [reviewEntry(original)],
      append: (_type, data: { state: ReviewState }) => {
        appended.push({ session: activeSession, state: data.state });
        if (rotateOnPending && data.state.posts.at(-1)?.status === "pending") {
          rotateOnPending = false;
          activeSession = "replacement";
          h.handlers.session_tree({}, replacementRuntime);
        }
      },
      exec: githubStub({
        post: async (_args, options) => {
          posts += 1;
          await postBlocked;
          expect(options.signal?.aborted).toBe(true);
          return { code: 1, stdout: "", stderr: "uncertain" };
        },
      }),
    });
    const runtime = (sessionId: string, review: ReviewState) => ({
      ...h.session([reviewEntry(review)], sessionId),
      ui: view.ctx.ui,
    });
    replacementRuntime = runtime("replacement", replacement);
    const originalRuntime = runtime("original", original);
    h.handlers.session_start({}, originalRuntime);

    await h.command("pr post r comment", originalRuntime);
    expect(posts).toBe(0);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      session: "original",
      state: { posts: [{ status: "pending" }] },
    });
    expect(appended.some((entry) => entry.session === "replacement")).toBe(false);

    h.handlers.session_shutdown();
    appended.length = 0;
    activeSession = "original";
    rotateOnPending = false;
    h.handlers.session_start({}, originalRuntime);
    const inFlight = h.command("pr post r comment", originalRuntime);
    await vi.waitFor(() => expect(posts).toBe(1));
    activeSession = "replacement";
    h.handlers.session_tree({}, replacementRuntime);
    releasePost();
    await inFlight;
    await Promise.resolve();
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      session: "original",
      state: { posts: [{ status: "pending" }] },
    });
    expect(appended.some((entry) => entry.session === "replacement")).toBe(false);
  });

  it.each([
    ["preface", "POST"],
    ["preface", "marker GET"],
    ["cleanup", "POST"],
    ["cleanup", "marker GET"],
  ])("keeps an interleaved %s authoritative after %s", async (action, phase) => {
    const base = root();
    const review = { ...state(base), preface: "confirmed preface" };
    const view = reviewContext(base);
    const confirm = vi.fn(async () => true);
    let payload!: { body: string };
    let posts = 0;
    let appendsAfterAction = 0;
    let runtime: any;
    async function interleave() {
      await h.command(`pr ${action} r`, runtime);
      expect(view.notes.at(-1)).toContain(
        action === "cleanup" ? "Review cleanup complete" : "Preface updated",
      );
      appendsAfterAction = h.appended.length;
    }
    const h = registeredReview({
      root: base,
      entries: [reviewEntry(review)],
      exec: githubStub({
        list: async () => {
          await interleave();
          return {
            code: 0,
            stdout: JSON.stringify([{ id: "remote1", body: payload.body }]),
            stderr: "",
          };
        },
        post: async (args) => {
          posts += 1;
          payload = JSON.parse(readFileSync(args.at(-1)!, "utf8"));
          if (phase === "POST") await interleave();
          return phase === "POST"
            ? { code: 0, stdout: JSON.stringify({ id: "remote1" }), stderr: "" }
            : { code: 1, stdout: "", stderr: "lost" };
        },
      }),
    });
    runtime = { ...h.session(), ui: { ...view.ctx.ui, confirm, editor: async () => "human-new" } };
    h.handlers.session_start({}, runtime);
    await h.command("pr post r comment", runtime);
    expect(payload.body).toContain(review.preface);
    expect(payload.body).not.toContain("human-new");
    expect(payload.body).toContain(h.appended[0].state.posts[0].marker);
    expect(posts).toBe(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    if (action === "cleanup") {
      await h.command("pr list", runtime);
      expect(view.notes.at(-1)).toBe("No active PR reviews.");
      expect(existsSync(review.snapshot.artifactDir)).toBe(false);
      expect(h.appended).toHaveLength(appendsAfterAction);
    } else {
      expect(view.notes.at(-1)).toMatch(/Review posted|Posted review reconciled/);
      expect(h.appended.at(-1).state.posts[0]).toMatchObject({
        status: "posted",
        reviewId: "remote1",
      });
      expect(
        h.appended
          .slice(appendsAfterAction - 1)
          .every((entry) => entry.state.preface === "human-new"),
      ).toBe(true);
    }
  });

  it("rejects unknown post events through the command", async () => {
    const review = state();
    const view = reviewContext(root());
    const h = registeredReview({ root: view.ctx.cwd, entries: [reviewEntry(review)] });
    h.handlers.session_start({}, h.session());
    await h.command("pr post r merge", view.ctx);
    expect(view.notes.at(-1)).toContain("Unknown review post event");
  });
});
