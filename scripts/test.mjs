import { fileURLToPath } from "node:url";
import { runSupervisedNode } from "./run-supervised-node.mjs";

const [mode, ...args] = process.argv.slice(2);
const filters = [];

switch (mode) {
  case "all":
    break;
  case "unit":
  case "integration":
    process.env.PI_ENV_TEST_PORTFOLIO = mode;
    break;
  case "e2e":
  case "native-tools":
  case "session-manager":
  case "real-workspace-canary":
    process.env.E2E = "1";
    if (mode === "native-tools") {
      filters.push(
        ".pi/extensions/__tests__/e2e.test.ts",
        ".pi/extensions/subagent/__tests__/e2e.test.ts",
      );
    } else if (mode === "session-manager") {
      filters.push(".pi/extensions/session-manager/__tests__/e2e.test.ts");
    } else if (mode === "real-workspace-canary") {
      process.env.REAL_WORKSPACE_CANARY = "1";
    }
    break;
  default:
    console.error(`Unknown test mode: ${mode ?? "(missing)"}`);
    process.exitCode = 2;
}

if (!process.exitCode) {
  const command = args[0] === "list" ? args.shift() : "run";
  await runSupervisedNode([
    "--heavyweight",
    fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
    command,
    ...filters,
    ...args,
  ]);
}
