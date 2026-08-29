import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithRetries } from "../generate-alpine-source-bundle.mjs";

afterEach(() => vi.restoreAllMocks());

describe("Alpine aports source fetch", () => {
  it("retries a transient fetch failure and succeeds", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const statuses = [1, 0];
    const runCommand = vi.fn(() => ({ status: statuses.shift() }));

    runWithRetries("git", ["fetch"], {}, 3, runCommand);

    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("fails closed after three permanent fetch failures", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const runCommand = vi.fn(() => ({ status: 1 }));

    expect(() => runWithRetries("git", ["fetch"], {}, 3, runCommand)).toThrow(
      "failed after 3 attempts",
    );
    expect(runCommand).toHaveBeenCalledTimes(3);
  });
});
