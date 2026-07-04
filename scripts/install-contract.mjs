import { loadExtensionManifest } from "./extension-manifest.mjs";
import { validateExtensionInstall } from "./extension-contract.mjs";
import { validatePackageInstall } from "./package-contract.mjs";

export function validateInstall(manifest = loadExtensionManifest()) {
  return [
    ...validateExtensionInstall(manifest),
    ...validatePackageInstall(manifest),
  ];
}
