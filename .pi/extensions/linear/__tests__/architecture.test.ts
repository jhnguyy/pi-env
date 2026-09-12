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
});
