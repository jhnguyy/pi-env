#!/usr/bin/env node
// clean-extension-artifacts.mjs — remove generated extension bundles and empty stale extension dirs.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { listExtensionDirs, loadExtensionManifest, relativeFromRepo } from "./extension-manifest.mjs";

const { extensionsDir } = loadExtensionManifest();
let removed = 0;

for (const dir of listExtensionDirs(extensionsDir)) {
  const dist = join(dir.absPath, "dist");
  if (existsSync(dist)) {
    rmSync(dist, { recursive: true, force: true });
    console.log(`removed ${relativeFromRepo(dist)}`);
    removed += 1;
  }

  const remaining = readdirSync(dir.absPath);
  if (!dir.name.startsWith("_") && remaining.length === 0) {
    rmSync(dir.absPath, { recursive: true, force: true });
    console.log(`removed empty ${relativeFromRepo(dir.absPath)}`);
  }
}

if (removed === 0) {
  console.log("No extension build artifacts found.");
}
