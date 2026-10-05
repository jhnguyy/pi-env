#!/usr/bin/env node
import { runChecked } from "../setup/runtime-support.mjs";

const node = process.argv[2] || process.env.PI_ENV_NODE_BIN || process.execPath;
const options = { cwd: process.cwd() };
runChecked(node, ["scripts/clean-extension-artifacts.mjs", "--stale-only"], options);
runChecked(node, ["scripts/patch-effect-language-service.mjs", node], options);
runChecked(node, ["scripts/build-extensions.mjs"], options);
runChecked("sh", ["scripts/restart-lsp-daemon.sh"], options);
