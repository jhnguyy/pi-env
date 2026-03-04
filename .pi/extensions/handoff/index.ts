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
		},
	});
}
