import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
}
