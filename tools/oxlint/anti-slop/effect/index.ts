import { eslintCompatPlugin } from "@oxlint/plugins";

import { noManualEffectErrorTagRule } from "./rules/no-manual-effect-error-tag.ts";

const antiSlopEffectPlugin = eslintCompatPlugin({
	meta: { name: "anti-slop-effect" },
	rules: {
		"no-manual-effect-error-tag": noManualEffectErrorTagRule,
	},
});

export default antiSlopEffectPlugin;
