import { describe, expect, it } from "vitest";
import { dscSha256Entries } from "../generate-debian-source-bundle.mjs";

describe("Debian source metadata", () => {
  it("parses every SHA-256 artifact from a signed .dsc file", () => {
    expect(
      dscSha256Entries(
        [
          "Format: 3.0 (quilt)",
          "Checksums-Sha256:",
          ` ${"a".repeat(64)} 12 package.orig.tar.xz`,
          ` ${"b".repeat(64)} 34 package.debian.tar.xz`,
          "Files:",
        ].join("\n"),
      ),
    ).toEqual([
      { sha256: "a".repeat(64), size: 12, file: "package.orig.tar.xz" },
      { sha256: "b".repeat(64), size: 34, file: "package.debian.tar.xz" },
    ]);
  });

  it("rejects a .dsc file without SHA-256 source metadata", () => {
    expect(() => dscSha256Entries("Format: 1.0\n")).toThrow(
      "Debian .dsc file has no Checksums-Sha256 field",
    );
  });
});
