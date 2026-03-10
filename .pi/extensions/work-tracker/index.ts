/**
 * Work Tracker Extension — entry point.
 *
 * Provides session lifecycle management:
 *   1. Branch guard       — blocks git push to protected branches (tool_call hook)
 *   2. Handoff cleanup    — deletes handoffs when their branch merges (tool_result hook)
 *   3. Context injection  — injects git branch + dirty status before root agent turns
 *   4. /handoff command   — write session handoff + retro
 *   5. todo tool          — agent-managed session task list
 *   6. read_session tool  — extract high-signal content from session JSONL files
 *   7. /review-retros     — review past retros and propose behavioral improvements
 *
 * Subagent detection: if PI_AGENT_ID env var is set, context injection is skipped
 * (subagents don't need this context, and injecting it wastes tokens).
 *
 * Config via env vars:
 *   WORK_TRACKER_REPOS      — comma-separated repo paths (default: pi-env only)
 *   WORK_TRACKER_PROTECTED  — comma-separated protected branches (default: main, master)
 *   PI_SESSION_READER       — if set, keeps read_session tool active (for review subagents)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { homedir } from "node:os";

import { BranchGuard } from "./branch-guard";
import {
	cleanupHandoffs,
	detectMergedBranch,
	isGitPull,
	parseMergedBranches,
} from "./handoff-cleanup";
import { TodoStore } from "./store";
import { extractSession, formatSummary } from "./extractor";
import type { WorkTrackerConfig } from "./types";

const SESSION_DIR = resolve(homedir(), ".pi/agent/sessions");

function loadConfig(): WorkTrackerConfig {
  const guardedRepos = process.env.WORK_TRACKER_REPOS
    ? process.env.WORK_TRACKER_REPOS.split(",").map((s) => s.trim())
    : ["/mnt/tank/code/pi-env"];

  const protectedBranches = process.env.WORK_TRACKER_PROTECTED
    ? process.env.WORK_TRACKER_PROTECTED.split(",").map((s) => s.trim())
    : ["main", "master"];

  return { guardedRepos, protectedBranches };
}

function getGitStatus(repoPath: string): { branch: string | null; dirty: number } {
  let branch: string | null = null;
  let dirty = 0;
  try {
    const b = spawnSync("git", ["-C", repoPath, "branch", "--show-current"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (b.status === 0 && b.stdout) branch = b.stdout.trim() || null;

    const s = spawnSync("git", ["-C", repoPath, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (s.status === 0 && s.stdout) {
      dirty = s.stdout.trim().split("\n").filter(Boolean).length;
    }
  } catch {
    // Ignore — repo may not exist
  }
  return { branch, dirty };
}

/** Get the branch of the current working directory. Reuses getGitStatus. */
function getCurrentBranch(): string | null {
  return getGitStatus(process.cwd()).branch;
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const guard = new BranchGuard(config);
  const store = new TodoStore();

  function refreshTodoWidget(ctx: ExtensionContext) {
    if (process.env.PI_AGENT_ID) return;
    ctx.ui.setWidget("session-todos", [store.render()], { placement: "belowEditor" });
  }

  function buildStatusLine(): string | null {
    const parts: string[] = [];
    for (const repoPath of config.guardedRepos) {
      const { branch, dirty } = getGitStatus(repoPath);
      if (!branch) continue;
      const name = repoPath.split("/").pop() ?? repoPath;
      const warn = config.protectedBranches.includes(branch) ? " (⚠️ protected branch)" : "";
      const dirtyNote = dirty > 0 ? ` (${dirty} uncommitted)` : "";
      parts.push(`${name}: ${branch}${warn}${dirtyNote}`);
    }
    return parts.length > 0 ? `[work-tracker] ${parts.join(" | ")}` : null;
  }

  // ─── 0. Commands ──────────────────────────────────────────────────

  pi.registerCommand("review-retros", {
    description: "Review last N session retros and propose behavioral improvements.\nUsage: /review-retros [N]  (default: last 5 retros)",
    handler: async (args, _ctx) => {
      const n = args && /^\d+$/.test(args.trim()) ? parseInt(args.trim(), 10) : 5;

      pi.sendUserMessage(
        `Review the last ${n} session retrospectives and propose behavioral improvements.\n` +
          `\n` +
          `Steps:\n` +
          `1. Read the last ${n} retro files from ~/.pi/retro/ (sorted by filename descending — newest first).\n` +
          `   Each file contains one or more sections with "### Patterns" and tagged items ([workflow],\n` +
          `   [tooling], [convention], [mistake], [knowledge]).\n` +
          `2. Read ~/.pi/agent/AGENTS.md.\n` +
          `3. Read all active skills in ~/.agents/skills/ (read each SKILL.md).\n` +
          `4. Identify recurring patterns across the retros — the same tag appearing 2 or more times\n` +
          `   with related observations.\n` +
          `5. For each recurring pattern, produce a single-rule proposal:\n` +
          `   - What was observed and how often\n` +
          `   - Proposed change: one AGENTS.md line, one skill rule, or one convention note\n` +
          `   - Exact diff (what to add/remove)\n` +
          `   - Rationale\n` +
          `   If the change is too large to be a single rule, file it as a task instead — do not\n` +
          `   propose it inline.\n` +
          `6. Present each proposal one at a time and ask: "Apply this? (yes/no/modify)"\n` +
          `7. Apply accepted proposals immediately using the appropriate tool.`,
      );
    },
  });

  pi.registerCommand("handoff", {
    description: "Write a session handoff and display the resume prompt",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
      const branch = getCurrentBranch();

      pi.sendUserMessage(
        `Write a handoff for this session following the handoff skill.\n` +
          `Use today's date (${date}) and model-used: ${model} in the frontmatter.\n` +
          (branch ? `Include a \`branch: ${branch}\` field in the frontmatter.\n` : ``) +
          `Save to ~/.pi/agent/handoffs/${date}-<slug>.md where <slug> is derived from the task.\n` +
          `After saving, display the full file path and the one-line resume prompt.`,
      );

      pi.sendUserMessage(
        `Write a session retrospective and save it to ~/.pi/retro/${date}.md\n` +
          `(create the file if it doesn't exist; append as a new section if it does).\n` +
          `\n` +
          `Use this exact format:\n` +
          `\n` +
          `## Session retro — <slug> (${date})\n` +
          `\n` +
          `<2-4 sentence freeform summary of what happened>\n` +
          `\n` +
          `### Patterns\n` +
          `- [workflow] <observation about how the work was done>\n` +
          `- [tooling] <gap or friction in an extension, skill, or tool>\n` +
          `- [convention] <coding or process pattern noticed>\n` +
          `- [mistake] <error that was caught — how and when>\n` +
          `- [knowledge] <domain discovery worth knowing next time>\n` +
          `\n` +
          `Only include tags where you have a concrete observation. Omit tags with nothing real to say.\n` +
          `If the worklog note already has content for today, append as a new section — do not overwrite.`,
      );
    },
  });

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Manage your session task list. Use to track multi-step plans, mark progress, " +
      "and keep yourself organized across turns. The list is visible in context every turn.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("add"),
          Type.Literal("done"),
          Type.Literal("rm"),
          Type.Literal("list"),
          Type.Literal("clear"),
        ],
        { description: "add: create task, done: complete by id, rm: remove by id, list: show all, clear: reset" },
      ),
      text: Type.Optional(
        Type.String({ description: "Task text (for add) or task id number (for done/rm)" }),
      ),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx: any) {
      const { action, text } = params;

      if (action === "list") {
        return { content: [{ type: "text" as const, text: store.render() }], details: {} };
      }

      if (action === "clear") {
        store.clear();
        refreshTodoWidget(ctx);
        return { content: [{ type: "text" as const, text: "Cleared all tasks." }], details: {} };
      }

      if (action === "add") {
        if (!text) throw new Error("text is required for add");
        const item = store.add(text);
        refreshTodoWidget(ctx);
        return {
          content: [{ type: "text" as const, text: `Added: □ (${item.id}) ${item.text}` }],
          details: { id: item.id },
        };
      }

      if (action === "done") {
        if (!text) throw new Error("text is required for done (pass task id)");
        const n = parseInt(text, 10);
        const item = store.complete(isNaN(n) ? text : n);
        if (!item) throw new Error(`No matching open task: ${text}`);
        refreshTodoWidget(ctx);
        return {
          content: [{ type: "text" as const, text: `Completed: ✅ (${item.id}) ${item.text}` }],
          details: { id: item.id },
        };
      }

      if (action === "rm") {
        if (!text) throw new Error("text is required for rm (pass task id)");
        const n = parseInt(text, 10);
        const ok = store.remove(isNaN(n) ? text : n);
        if (!ok) throw new Error(`No matching task: ${text}`);
        refreshTodoWidget(ctx);
        return {
          content: [{ type: "text" as const, text: `Removed task ${text}.` }],
          details: {},
        };
      }

      throw new Error(`Unknown action: ${action}`);
    },
  });

  // ─── read_session tool ────────────────────────────────────────────

  pi.registerTool({
    name: "read_session",
    label: "Read Session",
    description:
      "Extract high-signal content from a pi session JSONL file. " +
      "Returns user prompts, agent narrative text (no raw tool outputs), " +
      "tool usage counts, and extension messages. " +
      "Use to understand what happened in a past session without parsing raw JSONL. " +
      "Discover session files with: find ~/.pi/agent/sessions/ -name '*.jsonl' | sort -r | head -20",
    parameters: Type.Object({
      path: Type.String({
        description: "Absolute path to a session .jsonl file under ~/.pi/agent/sessions/",
      }),
    }),

    async execute(_id, params, signal, _onUpdate, _ctx: any) {
      // Check cancellation before doing any I/O
      if (signal?.aborted) {
        return { content: [{ type: "text" as const, text: "Cancelled." }], details: {} };
      }

      // Strip leading @ (some models include it in path arguments)
      const p = resolve(params.path.replace(/^@/, ""));

      // Restrict to session directory — prevents read_session from being
      // used as a general-purpose JSONL reader on arbitrary files.
      if (!p.startsWith(SESSION_DIR + "/")) {
        throw new Error(
          `read_session is restricted to session files under ${SESSION_DIR}/. Got: ${p}`,
        );
      }

      // extractSession validates extension and existence — errors propagate as tool errors
      const summary = extractSession(p);
      const raw = formatSummary(summary);

      // Truncate to avoid overwhelming the LLM context window
      const trunc = truncateHead(raw, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      let text = trunc.content;
      if (trunc.truncated) {
        text +=
          `\n\n[Output truncated: ${formatSize(trunc.outputBytes)} of ${formatSize(trunc.totalBytes)}. ` +
          `Session had ${summary.userMessages.length} user turns and ${summary.agentNarrative.length} narrative blocks.]`;
      }

      return {
        content: [{ type: "text" as const, text }],
        details: {
          filename: summary.filename,
          timestamp: summary.timestamp,
          toolCounts: summary.toolCounts,
          truncated: trunc.truncated,
        },
      };
    },
  });

  // ─── 1. Branch Guard ──────────────────────────────────────────────
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return undefined;
    const command = (event.input as Record<string, string>).command ?? "";
    const result = guard.check(command);
    if (result.shouldBlock) {
      return { block: true, reason: result.reason };
    }
    return undefined;
  });

  // ─── 2. Handoff cleanup on merge ─────────────────────────────────
  //
  // Path A — local git merge (fast-forward or merge commit):
  //   Fires when the agent runs `git merge <branch>` directly.
  //
  // Path B — git pull on a protected branch (GitHub PR merge workflow):
  //   After any git pull, checks each guarded repo. If we're on a protected
  //   branch, collects all locally-known merged branches and cleans up their
  //   handoffs. This covers the common flow: PR merges on GitHub → agent runs
  //   `git checkout main && git pull`.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash" || event.isError) return;

    const command = (event.input as Record<string, string>).command ?? "";
    const output = (event.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");

    // ── Path A: local git merge ──────────────────────────────────
    const mergedBranch = detectMergedBranch(command, output);
    if (mergedBranch) {
      const deleted = cleanupHandoffs(mergedBranch);
      if (deleted.length > 0) {
        ctx.ui.notify(
          `🧹 Merged ${mergedBranch} — deleted ${deleted.length} handoff(s): ${deleted.join(", ")}`,
          "info",
        );
      }
      return;
    }

    // ── Path B: git pull on a protected branch ───────────────────
    if (!isGitPull(command)) return;

    const allMerged = new Set<string>();
    for (const repoPath of config.guardedRepos) {
      const { branch: current } = getGitStatus(repoPath);
      if (!current || !config.protectedBranches.includes(current)) continue;

      const result = spawnSync(
        "git",
        ["-C", repoPath, "branch", "--merged", "HEAD"],
        { encoding: "utf8", timeout: 3000 },
      );
      if (result.status !== 0 || !result.stdout) continue;

      for (const branch of parseMergedBranches(result.stdout)) {
        // Exclude the protected branches themselves
        if (!config.protectedBranches.includes(branch)) {
          allMerged.add(branch);
        }
      }
    }

    if (allMerged.size === 0) return;

    const deleted = cleanupHandoffs(allMerged);
    if (deleted.length > 0) {
      ctx.ui.notify(
        `🧹 Pulled main — deleted ${deleted.length} handoff(s): ${deleted.join(", ")}`,
        "info",
      );
    }
  });

  // ─── 3. Session start — widget init, todo clear, tool deactivation ───
  pi.on("session_start", async (_event, ctx) => {
    // Clear todo list on new session
    store.clear();

    if (process.env.PI_AGENT_ID) return;

    // Refresh work-tracker git status widget
    const line = buildStatusLine();
    if (line) ctx.ui.setWidget("work-tracker", [line], { placement: "belowEditor" });

    // Refresh todo widget (empty after clear)
    refreshTodoWidget(ctx);

    // Deactivate read_session in normal sessions — set PI_SESSION_READER=1 to keep it
    // active (for dedicated review subagents).
    if (!process.env.PI_SESSION_READER) {
      pi.setActiveTools(pi.getActiveTools().filter((t) => t !== "read_session"));
    }
  });

  // ─── 4. Context injection + widget refresh (root sessions only) ───
  pi.on("before_agent_start", async (_event, ctx) => {
    // Skip context injection for subagents — PI_AGENT_ID is set by pi
    // when spawning subagents via the tmux tool
    if (process.env.PI_AGENT_ID) return {};

    const line = buildStatusLine();

    // Refresh the persistent widget with latest git state
    if (line) ctx.ui.setWidget("work-tracker", [line], { placement: "belowEditor" });

    // Refresh todo widget
    refreshTodoWidget(ctx);

    if (!line) return {};

    return {
      message: {
        customType: "work-tracker",
        content: line,
        display: false,
      },
    };
  });

  // ─── 5. Todo context injection (root sessions only) ───────────────
  pi.on("before_agent_start", async () => {
    // Skip for subagents — PI_AGENT_ID is set by pi when spawning subagents
    if (process.env.PI_AGENT_ID) return {};

    return {
      message: {
        customType: "session-todos",
        content: store.render(),
        display: false,
      },
    };
  });
}
