import { createHash } from "node:crypto";
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
    "THIRD_PARTY_LICENSES/DEBIAN_PACKAGES.md",
    "THIRD_PARTY_LICENSES/DEBIAN_SOURCE_CODE.md",
    "THIRD_PARTY_LICENSES/system/node-LICENSE.txt",
  ])
    write(join(root, path));
  mkdirSync(join(root, ".pi/extensions/dev-tools/dist"), { recursive: true });
  const content = "source\n";
  const file = "artifacts/bash/bash.dsc";
  write(join(root, "THIRD_PARTY_SOURCES/debian", file), content);
  write(
    join(root, "THIRD_PARTY_SOURCES/debian/manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      debianSources: [
        {
          name: "bash",
          artifacts: [{ file, sha256: createHash("sha256").update(content).digest("hex") }],
        },
      ],
    })}\n`,
  );
  return root;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
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

  it("rejects source artifacts outside the source bundle", () => {
    const root = validArtifact();
    write(
      join(root, "THIRD_PARTY_SOURCES/debian/manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        debianSources: [
          {
            name: "bash",
            artifacts: [{ file: "../../outside.tar.gz", sha256: "0".repeat(64) }],
          },
        ],
      })}\n`,
    );
    expect(imageArtifactIssues(root)).toContain(
      "bash: source artifact is missing, empty, or invalid",
    );
  });
});
