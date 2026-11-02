import { describe, expect, it } from "vitest";
import { pathToUri, uriToPath } from "../utils";

// These examples qualify native Linux paths, not Windows drive or UNC semantics.
describe.skipIf(process.platform !== "linux")("file URI conversion", () => {
  it.each([
    ["file:///repo/spaced%20file.ts", "/repo/spaced file.ts"],
    ["file:///repo/caf%C3%A9.ts", "/repo/café.ts"],
    ["file:///repo/literal%2520.ts", "/repo/literal%20.ts"],
    ["file:///repo/plain.ts", "/repo/plain.ts"],
  ])("decodes external URI %s to a native path", (uri, path) => {
    expect(uriToPath(uri)).toBe(path);
  });

  it.each([
    ["/repo/plain.ts", "/repo/plain.ts"],
    ["relative%20file.ts", "relative%20file.ts"],
    ["https://example.test/a%20b", "https://example.test/a%20b"],
    ["file:///repo/bad%ZZ.ts", "/repo/bad%ZZ.ts"],
    ["file:///repo/incomplete%.ts", "/repo/incomplete%.ts"],
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

  it.each([
    ["spaced file.ts", "/spaced%20file.ts"],
    ["literal%20.ts", "/literal%2520.ts"],
    ["hash#.ts", "/hash%23.ts"],
    ["query?.ts", "/query%3F.ts"],
  ])("escapes and roundtrips the literal filename %s", (filename, suffix) => {
    const path = `/repo/${filename}`;
    const uri = pathToUri(path);
    expect(uri).toBe(`file:///repo${suffix}`);
    expect(uriToPath(uri)).toBe(path);
  });
});
