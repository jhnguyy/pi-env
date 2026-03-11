/**
 * commands.ts — slash command registrations for work-tracker.
 *
 *   /review-retros [N]  — review last N retros, propose behavioral improvements
 *   /handoff            — write session handoff + retrospective
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { getCurrentBranch } from "./context";

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("review-retros", {
    description:
      "Review last N session retros and propose behavioral improvements.\nUsage: /review-retros [N]  (default: last 5 retros)",
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
}
