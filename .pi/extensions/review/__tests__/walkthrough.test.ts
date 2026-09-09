import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { clearInMemoryStateForTests } from "../index";
import { runRealReviewFlow } from "./fixtures/review-flow";
import { persistedReviewEntries, registeredReview, reviewContext } from "./fixtures/review-ui";

afterEach(clearInMemoryStateForTests);

async function harness() {
  const flow = await runRealReviewFlow();
  return {
    flow,
    ...registeredReview({
      root: flow.root,
      sessionDir: flow.sessionDir,
      sessionId: flow.sessionId,
      entries: flow.entries,
    }),
  };
}

describe("registered review walkthrough boundary", () => {
  it.each(["running", "unavailable"])(
    "does not claim complete coverage when restored evidence is %s",
    async (status) => {
      const h = await harness();
      const state = structuredClone(h.flow.state);
      if (status === "running") state.dag!.status = "running";
      else delete state.plan;
      h.handlers.session_start(
        {},
        h.session(persistedReviewEntries(h.flow.entries, [{ reviewId: state.snapshot.id, state }])),
      );
      const view = reviewContext(h.flow.root, false);
      await h.command(`pr walkthrough ${state.snapshot.id}`, view.ctx);
      expect(view.notes.at(-1)).toContain(`Coverage: ${status}`);
      expect(h.appended).toHaveLength(0);
    },
  );

  it("hands the real finalized DAG result to restore, inspection, and persistent decisions", async () => {
    const h = await harness();
    const [selected, rejected, deferred] = h.flow.state.result!.findings;
    const findingId = selected.id!;
    const raw = h.flow.state.result!.provenance!.rawFindings[0];

    // Negative control: the consumer cannot see the producer result unless its save entries cross
    // the extension restore boundary.
    h.handlers.session_start({}, h.session([]));
    const disconnected = reviewContext(h.flow.root, false);
    await h.command(`pr walkthrough ${h.flow.state.snapshot.id}`, disconnected.ctx);
    expect(disconnected.notes.at(-1)).toContain("not found");

    h.handlers.session_tree({}, h.session());
    const pending = reviewContext(h.flow.root, false);
    await h.command(`pr walkthrough ${h.flow.state.snapshot.id}`, pending.ctx);
    expect(pending.notes.at(-1)).toContain(`${findingId} [pending]`);
    expect(h.appended).toHaveLength(0);

    const choices: Array<string | ((options: string[]) => string | undefined)> = [
      "Reading plan",
      (options) => options.find((option) => option.includes("a.ts")),
      "Next",
      "Back",
      "Back",
      "Findings",
      (options) => options.find((option) => option.includes(findingId)),
      "Select for posting",
      "Back",
      "Edit presentation",
      "Back",
      "Back",
      "Back",
      "Provenance",
      `${raw.id} [${raw.role}] #${raw.index}`,
      "Back",
      "Back",
      "Exit",
    ];
    const shown: string[] = [];
    await h.command(`pr walkthrough ${h.flow.state.snapshot.id}`, {
      hasUI: true,
      cwd: h.flow.root,
      sessionManager: h.session().sessionManager,
      ui: {
        notify() {},
        select: async (title: string, options: string[]) => {
          shown.push(title);
          const choice = choices.shift();
          return typeof choice === "function" ? choice(options) : choice;
        },
        editor: async () =>
          "Problem: edited\nConsequence: edited consequence\nSuggested fix: edited fix",
      },
    });
    const pages = shown.filter((title) => title.includes("\n\nPage "));
    expect(pages.join("\n")).toContain("+export const value = 1;");
    expect(pages.join("\n")).toContain("end-of-later-evidence");
    expect(shown.find((title) => title.startsWith("Anchor: a.ts:1"))).toContain(
      "+export const value = 1;",
    );
    const rawPage = shown.find((title) => title.startsWith(`Raw finding ${raw.id}`));
    expect(rawPage).toContain(raw.evidenceDigest);
    expect(rawPage).toContain(selected.problem);
    expect(pages.every((page) => page.length < 5_050)).toBe(true);

    await h.command(
      `pr reject ${h.flow.state.snapshot.id} ${rejected.id}`,
      reviewContext(h.flow.root).ctx,
    );
    await h.command(
      `pr defer ${h.flow.state.snapshot.id} ${deferred.id}`,
      reviewContext(h.flow.root).ctx,
    );
    expect(h.appended.at(-1).state.result.findings[0]).toMatchObject({
      id: findingId,
      problem: "edited",
      rawFindingIds: h.flow.state.result!.findings[0].rawFindingIds,
    });

    h.handlers.session_tree({}, h.session(persistedReviewEntries(h.flow.entries, h.appended)));
    const restored = reviewContext(h.flow.root, false);
    await h.command(`pr walkthrough ${h.flow.state.snapshot.id}`, restored.ctx);
    expect(restored.notes.at(-1)).toContain(`${findingId} [selected]`);
    expect(restored.notes.at(-1)).toContain(`${rejected.id} [rejected]`);
    expect(restored.notes.at(-1)).toContain(`${deferred.id} [deferred]`);
    expect(restored.notes.at(-1)).toContain("Interactive decisions unavailable");
    expect(h.githubCalls()).toBe(0);
  });

  it("rejects unknown finding IDs without applying part of a decision", async () => {
    const h = await harness();
    h.handlers.session_start({}, h.session());
    const view = reviewContext(h.flow.root);
    await h.command(
      `pr select ${h.flow.state.snapshot.id} ${h.flow.state.result!.findings[0].id} unknown`,
      view.ctx,
    );
    expect(view.notes.at(-1)).toContain("not owned");
    expect(h.appended).toHaveLength(0);
  });

  it("fails closed when the real run's pinned diff is tampered", async () => {
    const h = await harness();
    h.handlers.session_start({}, h.session());
    writeFileSync(h.flow.state.snapshot.diffPath, "tampered");
    const notices: string[] = [];
    const choices = ["Reading plan", "1. a.ts [high] - implementation"];
    await h.command(`pr walkthrough ${h.flow.state.snapshot.id}`, {
      hasUI: true,
      ui: {
        notify: (message: string) => notices.push(message),
        select: async () => choices.shift(),
      },
    });
    expect(notices.at(-1)).toContain("Pinned diff integrity check failed");
    expect(h.githubCalls()).toBe(0);
  });

  it.each(["editor", "decision"])(
    "rejects a stale %s after the restored session is replaced",
    async (action) => {
      const h = await harness();
      h.handlers.session_start({}, h.session());
      const findingId = h.flow.state.result!.findings[0].id;
      const notices: string[] = [];
      let release!: (text: string) => void;
      let entered!: () => void;
      const opened = new Promise<void>((resolve) => (entered = resolve));
      const waitForUser = () =>
        new Promise<string>((resolve) => {
          release = resolve;
          entered();
        });
      const command =
        action === "editor"
          ? `pr edit ${h.flow.state.snapshot.id} ${findingId}`
          : `pr walkthrough ${h.flow.state.snapshot.id}`;
      const editing = h.command(command, {
        hasUI: true,
        ui: {
          notify: (message: string) => notices.push(message),
          editor: waitForUser,
          select: async (_title: string, options: string[]) => {
            if (options.includes("Findings")) return "Findings";
            if (options.includes("Select for posting")) return waitForUser();
            return options.find((option) => option.includes(findingId!));
          },
        },
      });
      await opened;
      h.handlers.session_tree({}, h.session(h.flow.entries, "replacement"));
      release(
        action === "editor"
          ? "Problem: stale\nConsequence: stale\nSuggested fix: stale"
          : "Select for posting",
      );
      await editing;
      expect(notices.at(-1)).toContain("session changed");
      expect(h.appended).toHaveLength(0);
      expect(h.githubCalls()).toBe(0);
    },
  );
});
