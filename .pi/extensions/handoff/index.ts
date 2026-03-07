import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Write a session handoff and display the resume prompt",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";

			pi.sendUserMessage(
				`Write a handoff for this session following the handoff skill.\n` +
					`Use today's date (${date}) and model-used: ${model} in the frontmatter.\n` +
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
