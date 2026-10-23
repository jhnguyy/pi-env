#!/usr/bin/env node
import { join } from "node:path";
import { runChecked } from "../setup/runtime-support.mjs";

const repo = process.cwd();
const cli = join(repo, "node_modules", "@effect", "tsgo", "dist", "effect-tsgo.cjs");
const nodeBin = process.argv[2] || process.env.PI_ENV_NODE_BIN || process.execPath;
runChecked(nodeBin, [cli, "patch", "--typescript", "--typescript-package", "@typescript/native"], {
  cwd: repo,
});
