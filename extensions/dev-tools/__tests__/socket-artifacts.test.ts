import { describe, expect, it, vi } from "vitest";
import { removeStaleArtifact, removeStaleArtifacts, type SocketArtifactFs } from "../socket-artifacts";

describe("removeStaleArtifact", () => {
  it("removes existing artifacts", () => {
    const fs: SocketArtifactFs = {
      existsSync: vi.fn(() => true),
      unlinkSync: vi.fn(),
    };

    expect(removeStaleArtifact("/tmp/stale.sock", fs)).toBe(true);
    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/stale.sock");
  });
});

describe("removeStaleArtifacts", () => {
  it("removes all existing artifacts and returns the removal count", () => {
    const fs: SocketArtifactFs = {
      existsSync: vi.fn((path: string) => !path.endsWith("missing.pid")),
      unlinkSync: vi.fn(),
    };

    expect(removeStaleArtifacts([
      "/tmp/stale.sock",
      "/tmp/missing.pid",
      "/tmp/stale.pid",
    ], fs)).toBe(2);
    expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/stale.sock");
    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/stale.pid");
  });

  it("continues after one artifact fails to unlink", () => {
    const fs: SocketArtifactFs = {
      existsSync: vi.fn(() => true),
      unlinkSync: vi.fn((path: string) => {
        if (path.endsWith("busy.sock")) throw new Error("busy");
      }),
    };

    expect(removeStaleArtifacts(["/tmp/busy.sock", "/tmp/stale.pid"], fs)).toBe(1);
    expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
  });
});
