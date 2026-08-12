import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { LinearErrorCode } from "../domain";
import { sdkCursorPage } from "../sdk-adapter";

describeIfEnabled("linear", "Linear architecture contracts", () => {
  it("rejects missing and repeated continuation cursors at the SDK boundary", () => {
    expect(() => sdkCursorPage([], { hasNextPage: true }, undefined, "current")).toThrow();
    try {
      sdkCursorPage([], { hasNextPage: true, endCursor: "current" }, undefined, "current");
      throw new Error("Expected pagination failure.");
    } catch (error) {
      expect(error).toMatchObject({ code: LinearErrorCode.Api });
    }
  });

  it("keeps SDK imports inside the adapter", async () => {
    const directory = join(process.cwd(), ".pi", "extensions", "linear");
    const files = (await readdir(directory)).filter(
      (name) => name.endsWith(".ts") && name !== "sdk-adapter.ts",
    );
    for (const file of files) {
      expect(await readFile(join(directory, file), "utf8"), file).not.toContain("@linear/sdk");
    }
  });

  it("uses SDK create IDs as retry-safe entity IDs", async () => {
    const sdkTypes = await readFile(
      join(
        process.cwd(),
        ".pi",
        "extensions",
        "linear",
        "node_modules",
        "@linear",
        "sdk",
        "dist",
        "index-DHA7xCPn.d.mts",
      ),
      "utf8",
    );
    const issueCreate = sdkTypes.slice(
      sdkTypes.indexOf("type IssueCreateInput ="),
      sdkTypes.indexOf("type IssueCreatePayload ="),
    );
    const commentCreate = sdkTypes.slice(
      sdkTypes.indexOf("type CommentCreateInput ="),
      sdkTypes.indexOf("type CommentCreatePayload ="),
    );

    expect(issueCreate).toContain("The identifier in UUID v4 format");
    expect(commentCreate).toContain("The identifier in UUID v4 format");
  });

  it("has one Effect-to-Promise runtime boundary", async () => {
    const directory = join(process.cwd(), ".pi", "extensions", "linear");
    const files = (await readdir(directory)).filter((name) => name.endsWith(".ts"));
    const callers: string[] = [];
    for (const file of files) {
      const source = await readFile(join(directory, file), "utf8");
      if (source.includes("Effect.runPromise")) callers.push(file);
    }
    expect(callers).toEqual(["effect-runtime.ts"]);
  });

  it("pins the generated SDK and declares all external runtime contracts", async () => {
    const pkg = JSON.parse(
      await readFile(join(process.cwd(), ".pi", "extensions", "linear", "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
    };

    expect(pkg.dependencies).toMatchObject({
      "@linear/sdk": "89.0.0",
      effect: "4.0.0-beta.97",
    });
    expect(pkg.peerDependencies).toMatchObject({
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-coding-agent": "*",
      typebox: "*",
    });
  });
});
