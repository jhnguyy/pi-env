import { describe, expect, it } from "vitest";
import { resolveNodeCommand } from "../platform";

describe("resolveNodeCommand", () => {
  it("selects PI_ENV_NODE_BIN only when nonempty", () => {
    expect(resolveNodeCommand({ PI_ENV_NODE_BIN: " /chosen/node " }, "/exec/node")).toBe("/chosen/node");
    expect(resolveNodeCommand({ PI_ENV_NODE_BIN: " " }, "/exec/node")).toBe("/exec/node");
  });
});
