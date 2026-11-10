#!/usr/bin/env node
// verify-install.mjs runs quick setup readiness checks. It is not a full test suite.
import { loadExtensionManifest } from "./extension-manifest.mjs";
import { validateInstall } from "./install-contract.mjs";

const manifest = loadExtensionManifest();
const errors = validateInstall(manifest);

if (errors.length > 0) {
  console.error("Install readiness check failed.");
  for (const error of errors) console.error(`  - ${error}`);
  console.error("Run `nub run build`. Then retry `nub run verify:install`.");
  process.exit(1);
}
console.log(`Install readiness check passed for ${manifest.extensions.length} extensions.`);
