import { describe, expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";

describeIfEnabled("dev-tools", "extension entrypoint", () => {
  it("registers action formatters and renderers when the tool bundle loads", async () => {
    vi.resetModules();

    await import("../index");
    const { getAction } = await import("../action-registry");

    expect(getAction("diagnostics")).toBeDefined();
    expect(getAction("hover")).toBeDefined();
  });
});
