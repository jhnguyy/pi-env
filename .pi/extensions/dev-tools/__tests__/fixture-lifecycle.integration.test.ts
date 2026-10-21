import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it, onTestFinished, vi } from "vitest";
import { noopToolingTelemetryRuntime } from "../../../../src/telemetry/tooling.js";
import type { LspClient } from "../client";
import { createLspDaemonFixture } from "./e2e-fixture";

// These failures happen before semantic requests reach a language server.
// Keep sockets and filesystem operations real. Inject only failures that the
// host cannot reliably induce. The other lifecycle cases check normal removal.
it("removes allocated resources when project preparation fails", () => {
  let directory = "";
  onTestFinished(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  expect(() =>
    createLspDaemonFixture((tmpDir) => {
      directory = tmpDir;
      throw new Error("Project preparation failed");
    }),
  ).toThrow("Project preparation failed");
  expect(directory).not.toBe("");
  expect(existsSync(directory)).toBe(false);
});

it("leaves failed socket startup resources owned by registered teardown", async () => {
  const fixture = createLspDaemonFixture((directory) => directory);
  onTestFinished(() => fixture.cleanup());
  mkdirSync(join(fixture.project, "t.sock"));
  await expect(fixture.start()).rejects.toThrow(/listen .*t\.sock/);
  expect(existsSync(fixture.project)).toBe(true);
  await fixture.cleanup();
  expect(existsSync(fixture.project)).toBe(false);
});

it("closes a rejected request's client before fixture cleanup and accepts a fresh request", async () => {
  const fixture = createLspDaemonFixture((directory) => directory);
  onTestFinished(() => fixture.cleanup());
  await fixture.start();
  let rejectedClient: LspClient | undefined;
  await expect(
    fixture.withClient(async (client) => {
      rejectedClient = client;
      return client.call({ action: "hover" });
    }),
  ).rejects.toThrow("path, line, and character required for hover");
  assert(rejectedClient);
  await expect(rejectedClient.call({ action: "status" })).rejects.toThrow("Client closed");
  expect(await fixture.callDaemon({ action: "status" })).toMatchObject({ action: "status" });
  await fixture.cleanup();
  await fixture.cleanup();
  expect(existsSync(fixture.project)).toBe(false);
});

it("refuses to spawn a replacement for an unavailable fixture-owned daemon", async () => {
  const fixture = createLspDaemonFixture((directory) => directory);
  onTestFinished(() => fixture.cleanup());
  await fixture.start();
  await fixture.callDaemon({ action: "shutdown" });
  await vi.waitFor(() => expect(existsSync(join(fixture.project, "t.sock"))).toBe(false));
  await expect(fixture.callDaemon({ action: "status" })).rejects.toThrow("fixture-owned daemon");
  expect(existsSync(join(fixture.project, "t.sock"))).toBe(false);
  expect(existsSync(join(fixture.project, "t.pid"))).toBe(false);
});

it("leaves a failed daemon replacement's project owned by registered teardown", async () => {
  const fixture = createLspDaemonFixture((directory) => directory);
  onTestFinished(() => fixture.cleanup());
  await fixture.start();
  const pidPath = join(fixture.project, "t.pid");
  rmSync(pidPath);
  mkdirSync(pidPath);
  await expect(fixture.restartDaemon()).rejects.toMatchObject({ code: "EISDIR" });
  expect(existsSync(fixture.project)).toBe(true);
  await fixture.cleanup();
  expect(existsSync(fixture.project)).toBe(false);
});

it("preserves a restart failure and reports shutdown and removal failures together", async () => {
  const shutdownError = new Error("Telemetry disposal failed");
  const removalError = new Error("Directory removal failed");
  let failDisposal = false;
  let failRemoval = true;
  // Telemetry integration checks own the normal disposal contract. The socket
  // lifecycle remains real even when disposal and directory removal fail.
  const fixture = createLspDaemonFixture((directory) => directory, {
    telemetry: {
      ...noopToolingTelemetryRuntime,
      disposeEffect: Effect.suspend(() => (failDisposal ? Effect.die(shutdownError) : Effect.void)),
    },
    removeDirectory: (directory, options) => {
      if (failRemoval) throw removalError;
      rmSync(directory, options);
    },
  });
  onTestFinished(async () => {
    failRemoval = false;
    try {
      await fixture.cleanup();
    } catch (error) {
      // A failed shutdown is cached by the daemon. Still release the project,
      // but do not suppress any unexpected cleanup failure.
      if (error !== shutdownError) throw error;
    }
  });
  await fixture.start();
  const pidPath = join(fixture.project, "t.pid");
  rmSync(pidPath);
  mkdirSync(pidPath);
  await expect(fixture.restartDaemon()).rejects.toMatchObject({ code: "EISDIR" });
  failDisposal = true;
  await expect(fixture.cleanup()).rejects.toMatchObject({ errors: [shutdownError, removalError] });
  failRemoval = false;
  // The cached shutdown failure must not prevent retrying real removal.
  await expect(fixture.cleanup()).rejects.toBe(shutdownError);
  expect(existsSync(fixture.project)).toBe(false);
});

it("preserves preparation and removal failures when allocation cannot return a fixture", () => {
  let directory = "";
  const preparationError = new Error("Project preparation failed");
  const removalError = new Error("Directory removal failed");
  onTestFinished(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  expect(() =>
    createLspDaemonFixture(
      (tmpDir) => {
        directory = tmpDir;
        writeFileSync(join(directory, "project.ts"), "export {};");
        throw preparationError;
      },
      {
        removeDirectory: () => {
          throw removalError;
        },
      },
    ),
  ).toThrow(expect.objectContaining({ errors: [preparationError, removalError] }));
});
