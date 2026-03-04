/**
 * Tmux integration tests — require a real tmux session.
 * Gate with TMUX_E2E=1 to run:
 *   TMUX_E2E=1 bun test ./.pi/extensions/__tests__/tmux/integration.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { TmuxClient } from "../tmux-client";
import { PaneManager } from "../pane-manager";
import type { TmuxConfig } from "../types";

const describeE2E = process.env.TMUX_E2E === "1" ? describe : describe.skip;

async function execShell(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

const CONFIG: TmuxConfig = {
  sessionPrefix: randomBytes(2).toString("hex"),
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describeE2E("tmux integration (TMUX_E2E=1)", () => {
  let client: TmuxClient;
  let manager: PaneManager;
  const spawnedPaneIds: string[] = [];

  beforeEach(() => {
    client = new TmuxClient(execShell);
    manager = new PaneManager(client, CONFIG);
    spawnedPaneIds.length = 0;
  });

  afterEach(async () => {
    // Kill all panes spawned during the test
    for (const paneId of spawnedPaneIds) {
      try {
        await manager.close(paneId, true);
      } catch {
        // Already closed or dead — ignore
      }
    }
  });

  it("spawns a pane and returns paneId and tmuxPaneId", async () => {
    expect(client.isInTmux()).toBe(true);
    const result = await manager.run({
      action: "run",
      command: "echo 'integration test line'",
      label: "test-spawn",
    });
    spawnedPaneIds.push(result.paneId);
    expect(result.paneId).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(result.tmuxPaneId).toMatch(/^%\d+$/);
    expect((result as any).outputFile).toBeUndefined();
  });

  it("read returns output from a spawned pane", async () => {
    const result = await manager.run({
      action: "run",
      command: "echo 'hello from read test'",
      label: "test-read",
    });
    spawnedPaneIds.push(result.paneId);

    // Wait for command to complete
    await sleep(500);

    const content = await manager.read(result.paneId);
    expect(content).toContain("hello from read test");
  });

  it("sends keys to a running interactive pane", async () => {
    const result = await manager.run({
      action: "run",
      command: "bash",
      label: "test-send",
      interactive: true,
    });
    spawnedPaneIds.push(result.paneId);
    await sleep(300);

    const sendResult = await manager.send(result.paneId, "echo 'sent via send-keys'");
    expect(sendResult.ok).toBe(true);

    await sleep(300);
    const content = await manager.read(result.paneId);
    expect(content).toContain("sent via send-keys");
  });

  it("close with kill removes the pane from tmux", async () => {
    const result = await manager.run({
      action: "run",
      command: "bash",
      label: "test-close",
    });
    const tmuxPaneId = result.tmuxPaneId;
    spawnedPaneIds.push(result.paneId);
    await sleep(200);

    expect(await client.isPaneAlive(tmuxPaneId)).toBe(true);
    await manager.close(result.paneId, true);
    // Remove from spawnedPaneIds since already closed
    spawnedPaneIds.splice(spawnedPaneIds.indexOf(result.paneId), 1);

    await sleep(200);
    expect(await client.isPaneAlive(tmuxPaneId)).toBe(false);
    expect(manager.getActivePanes().length).toBe(0);
  });

  it("rebalanceLayout is called after spawning a pane (no error in real tmux)", async () => {
    // Just verify spawn + rebalance doesn't throw in a real tmux session
    const result = await manager.run({
      action: "run",
      command: "echo layout-test",
      label: "layout-test",
    });
    spawnedPaneIds.push(result.paneId);
    expect(result.tmuxPaneId).toBeTruthy();
  });
});
