import { fileURLToPath } from "node:url";
import { runSupervisedNode } from "./run-supervised-node.mjs";

await runSupervisedNode([
  "--heavyweight",
  "--command",
  fileURLToPath(new URL("./tool-node-run.sh", import.meta.url)),
  fileURLToPath(new URL("../node_modules/oxlint/bin/oxlint", import.meta.url)),
  ".",
  "--type-aware",
  "--threads=1",
  "--deny-warnings",
  "--ignore-pattern",
  "tests/**",
  "--ignore-pattern",
  "**/dist/**",
  ...process.argv.slice(2),
]);
