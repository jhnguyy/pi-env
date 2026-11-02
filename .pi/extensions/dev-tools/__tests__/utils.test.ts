import { describe, expect, it } from "vitest";
import { pathToUri, uriToPath } from "../utils";

// These examples qualify native Linux paths, not Windows drive or UNC semantics.
describe.skipIf(process.platform !== "linux")("file URI conversion", () => {
  it("encodes literal filename characters and decodes an external URI exactly once", () => {
    expect(pathToUri("/repo/café literal%20#?.ts")).toBe(
      "file:///repo/caf%C3%A9%20literal%2520%23%3F.ts",
    );
    expect(uriToPath("file:///repo/caf%C3%A9%20literal%2520%23%3F.ts")).toBe(
      "/repo/café literal%20#?.ts",
    );
  });

  it.each([
    ["/repo/plain.ts", "/repo/plain.ts"],
    ["relative%20file.ts", "relative%20file.ts"],
    ["https://example.test/a%20b", "https://example.test/a%20b"],
    ["file:///repo/bad%ZZ.ts", "/repo/bad%ZZ.ts"],
    ["file:///repo/%FF.ts", "/repo/%FF.ts"],
    ["file:///repo/encoded%2Fseparator.ts", "/repo/encoded%2Fseparator.ts"],
    ["file://remote/repo/a%20b.ts", "remote/repo/a%20b.ts"],
    ["file://[broken", "[broken"],
  ])("preserves legacy fallback for %s", (input, expected) => {
    expect(uriToPath(input)).toBe(expected);
  });

  it("keeps ordinary absolute paths unchanged", () => {
    expect(pathToUri("/repo/src/plain.ts")).toBe("file:///repo/src/plain.ts");
  });

  it("resolves relative paths against the current working directory", () => {
    const uri = pathToUri("src/plain.ts");
    expect(uri.endsWith("/src/plain.ts")).toBe(true);
    expect(uriToPath(uri)).toBe(`${process.cwd()}/src/plain.ts`);
  });
});
