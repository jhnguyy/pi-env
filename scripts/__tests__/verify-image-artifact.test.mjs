import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { imageArtifactIssues } from "../verify-image-artifact.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "pi-env-image-artifact-"));
  temporaryDirectories.push(path);
  return path;
}

function write(path, content = "content\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function validArtifact() {
  const root = temporaryDirectory();
  for (const path of [
    "THIRD_PARTY_LICENSES/manifest.json",
    "THIRD_PARTY_LICENSES/THIRD_PARTY_NOTICES.md",
    "THIRD_PARTY_LICENSES/SOURCE_CODE.md",
    "THIRD_PARTY_LICENSES/ALPINE_PACKAGES.md",
    "THIRD_PARTY_LICENSES/ALPINE_SOURCE_CODE.md",
    "THIRD_PARTY_LICENSES/system/node-LICENSE.txt",
  ]) {
    write(join(root, path));
  }
  mkdirSync(join(root, ".pi/extensions/dev-tools/dist"), { recursive: true });
  write(join(root, "THIRD_PARTY_SOURCES/alpine/archives/busybox.src.tar.gz"));
  write(
    join(root, "THIRD_PARTY_SOURCES/alpine/manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      sources: [{
        origin: "busybox",
        archive: "archives/busybox.src.tar.gz",
      }],
    })}\n`,
  );
  return root;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("image artifact contract", () => {
  it("accepts a complete image artifact", () => {
    expect(imageArtifactIssues(validArtifact())).toEqual([]);
  });

  it("reports missing required outputs", () => {
    const root = temporaryDirectory();

    expect(imageArtifactIssues(root)).toContain(
      "required image file is missing: THIRD_PARTY_LICENSES/manifest.json",
    );
    expect(imageArtifactIssues(root)).toContain(
      "required image directory is missing: .pi/extensions/dev-tools/dist",
    );
  });

  it("rejects source archives outside the source bundle", () => {
    const root = validArtifact();
    write(
      join(root, "THIRD_PARTY_SOURCES/alpine/manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        sources: [{ origin: "busybox", archive: "../../outside.tar.gz" }],
      })}\n`,
    );

    expect(imageArtifactIssues(root)).toContain(
      "busybox: source archive is missing or empty",
    );
  });
});
