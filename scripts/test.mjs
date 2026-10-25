import { fileURLToPath } from "node:url";
import { runSupervisedNode } from "./run-supervised-node.mjs";

const [mode, ...args] = process.argv.slice(2);

switch (mode) {
  case "all":
    break;
  case "unit":
  case "integration":
    process.env.PI_ENV_TEST_PORTFOLIO = mode;
    break;
  case "e2e":
    process.env.E2E = "1";
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
    ...args,
  ]);
}
