import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { LspClient } from "../client";
import { createLspDaemonE2EFixture } from "./e2e-fixture";

// These failures happen before semantic requests reach a language server.
// Use real daemon sockets and filesystem errors rather than replacing their IO.
it.each(["project preparation", "socket listen"])(
  "removes project resources after failed %s",
  async (failure) => {
    let projectDir = "";
    try {
      await expect(
        createLspDaemonE2EFixture((tmpDir) => {
          projectDir = tmpDir;
          if (failure === "project preparation") throw new Error("Project preparation failed");
          mkdirSync(join(tmpDir, "t.sock"));
        }),
      ).rejects.toThrow(
        failure === "project preparation" ? "Project preparation failed" : /listen .*t\.sock/,
      );
      expect(projectDir).not.toBe("");
      expect(existsSync(projectDir)).toBe(false);
      console.info({
        failure,
        expected: "factory rejects and removes project",
        removed: !existsSync(projectDir),
      });
    } finally {
      // Also contain temporary negative-control mutations of fixture cleanup.
      if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    }
  },
);

it("closes a rejected request's client before fixture cleanup and accepts a fresh request", async () => {
  const fixture = await createLspDaemonE2EFixture();
  let rejectedClient: LspClient | undefined;
  try {
    await expect(
      fixture.withClient(async (client) => {
        rejectedClient = client;
        return client.call({ action: "hover" });
      }),
    ).rejects.toThrow("path, line, and character required for hover");
    await expect(rejectedClient!.call({ action: "status" })).rejects.toThrow("Client closed");
    expect(await fixture.callDaemon({ action: "status" })).toMatchObject({ action: "status" });
  } finally {
    rejectedClient?.close();
    await fixture.cleanup();
  }
  await fixture.cleanup();
  expect(existsSync(fixture.tmpDir)).toBe(false);
  console.info({
    failure: "rejected request",
    expected: "client closed; fresh request succeeds; cleanup idempotent",
    removed: !existsSync(fixture.tmpDir),
  });
});

it("refuses to spawn a replacement for an unavailable fixture-owned daemon", async () => {
  const fixture = await createLspDaemonE2EFixture();
  try {
    await fixture.callDaemon({ action: "shutdown" });
    await vi.waitFor(() => expect(existsSync(fixture.socketPath)).toBe(false));
    await expect(fixture.callDaemon({ action: "status" })).rejects.toThrow("fixture-owned daemon");
    expect(existsSync(fixture.socketPath)).toBe(false);
    expect(existsSync(fixture.pidPath)).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

it("owns cleanup of a failed daemon replacement", async () => {
  const fixture = await createLspDaemonE2EFixture();
  try {
    rmSync(fixture.pidPath);
    mkdirSync(fixture.pidPath);
    await expect(fixture.restartDaemon()).rejects.toMatchObject({ code: "EISDIR" });
    expect(existsSync(fixture.tmpDir)).toBe(false);
  } finally {
    await fixture.cleanup();
  }
  console.info({
    failure: "replacement PID write",
    expected: "restart rejects and removes project",
    removed: !existsSync(fixture.tmpDir),
  });
});
