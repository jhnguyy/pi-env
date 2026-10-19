import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it, onTestFinished, vi } from "vitest";
import { noopToolingTelemetryRuntime } from "../../../../src/telemetry/tooling.js";
import type { LspClient } from "../client";
import { createLspDaemonFixture } from "./e2e-fixture";

// These failures happen before semantic requests reach a language server.
// Use real daemon sockets and filesystem errors rather than replacing their IO.
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
  let failDisposal = false;
  // Socket shutdown is real. Only the otherwise infallible telemetry disposal
  // boundary fails; the existing telemetry integration suite checks its contract.
  const fixture = createLspDaemonFixture((directory) => directory, {
    ...noopToolingTelemetryRuntime,
    disposeEffect: Effect.suspend(() => (failDisposal ? Effect.die(shutdownError) : Effect.void)),
  });
  onTestFinished(async () => {
    if (existsSync(fixture.project)) chmodSync(fixture.project, 0o700);
    failDisposal = false;
    // The daemon retains its rejected shutdown promise. Cleanup must still
    // retry project removal without losing that original shutdown failure.
    await expect(fixture.cleanup()).rejects.toThrow("Telemetry disposal failed");
    expect(existsSync(fixture.project)).toBe(false);
  });
  await fixture.start();
  const pidPath = join(fixture.project, "t.pid");
  rmSync(pidPath);
  mkdirSync(pidPath);
  await expect(fixture.restartDaemon()).rejects.toMatchObject({ code: "EISDIR" });
  failDisposal = true;
  chmodSync(fixture.project, 0);
  await expect(fixture.cleanup()).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ message: "Telemetry disposal failed" }),
      expect.objectContaining({ code: "EACCES" }),
    ],
  });
});

it("preserves preparation and removal failures when allocation cannot return a fixture", () => {
  let directory = "";
  const preparationError = new Error("Project preparation failed");
  onTestFinished(() => {
    if (directory && existsSync(directory)) {
      chmodSync(directory, 0o700);
      rmSync(directory, { recursive: true, force: true });
    }
  });
  expect(() =>
    createLspDaemonFixture((tmpDir) => {
      directory = tmpDir;
      writeFileSync(join(directory, "project.ts"), "export {};");
      chmodSync(directory, 0);
      throw preparationError;
    }),
  ).toThrow(
    expect.objectContaining({
      errors: [preparationError, expect.objectContaining({ code: "EACCES" })],
    }),
  );
});
