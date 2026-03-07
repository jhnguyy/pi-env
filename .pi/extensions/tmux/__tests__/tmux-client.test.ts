import { describe, expect, it, beforeEach } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { TmuxClient } from "../tmux-client";
import { TmuxError } from "../types";
import type { ExecFn } from "../types";

type ExecResult = { stdout: string; stderr: string; code: number };

function mockExec(responses: ExecResult | ExecResult[]): ExecFn {
  let calls = 0;
  const arr = Array.isArray(responses) ? responses : [responses];
  return async (_cmd, _args, _opts) => {
    const resp = arr[calls] ?? arr[arr.length - 1];
    calls++;
    return resp;
  };
}

function captureExec(): { calls: Array<{ cmd: string; args: string[] }>; fn: ExecFn } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fn: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: "", stderr: "", code: 0 };
  };
  return { calls, fn };
}

describeIfEnabled("tmux", "TmuxClient", () => {
  // ─── isInTmux ───────────────────────────────────────────────

  describe("isInTmux()", () => {
    it("returns true when TMUX env var is set", () => {
      const orig = process.env.TMUX;
      process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
      const client = new TmuxClient(mockExec({ stdout: "", stderr: "", code: 0 }));
      expect(client.isInTmux()).toBe(true);
      if (orig === undefined) delete process.env.TMUX;
      else process.env.TMUX = orig;
    });

    it("returns false when TMUX env var is unset", () => {
      const orig = process.env.TMUX;
      delete process.env.TMUX;
      const client = new TmuxClient(mockExec({ stdout: "", stderr: "", code: 0 }));
      expect(client.isInTmux()).toBe(false);
      if (orig !== undefined) process.env.TMUX = orig;
    });

    it("returns false when TMUX env var is empty string", () => {
      const orig = process.env.TMUX;
      process.env.TMUX = "";
      const client = new TmuxClient(mockExec({ stdout: "", stderr: "", code: 0 }));
      expect(client.isInTmux()).toBe(false);
      if (orig === undefined) delete process.env.TMUX;
      else process.env.TMUX = orig;
    });
  });

  // ─── splitWindow ────────────────────────────────────────────

  describe("splitWindow()", () => {
    it("sends correct args for direction=right (-h)", async () => {
      const { calls, fn } = captureExec();
      // Override fn to return a pane id
      const execFn: ExecFn = async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: "%5\n", stderr: "", code: 0 };
      };
      const client = new TmuxClient(execFn);
      const paneId = await client.splitWindow("right", "bash");
      expect(calls[0].cmd).toBe("tmux");
      expect(calls[0].args).toContain("split-window");
      expect(calls[0].args).toContain("-h");
      expect(calls[0].args).toContain("-d");
      expect(calls[0].args).toContain("-P");
      expect(calls[0].args).toContain("-F");
      expect(calls[0].args).toContain("#{pane_id}");
      expect(calls[0].args).toContain("bash");
    });

    it("sends correct args for direction=below (-v)", async () => {
      const { calls, fn } = captureExec();
      const execFn: ExecFn = async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: "%3\n", stderr: "", code: 0 };
      };
      const client = new TmuxClient(execFn);
      await client.splitWindow("below", "bash");
      expect(calls[0].args).toContain("-v");
      expect(calls[0].args).not.toContain("-h");
    });

    it("includes -t flag when targetPaneId is provided", async () => {
      const { calls, fn } = captureExec();
      const execFn: ExecFn = async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: "%7\n", stderr: "", code: 0 };
      };
      const client = new TmuxClient(execFn);
      await client.splitWindow("below", "bash", "%3");
      expect(calls[0].args).toContain("-t");
      expect(calls[0].args).toContain("%3");
      // -t must come before the command
      const tIdx = calls[0].args.indexOf("-t");
      const cmdIdx = calls[0].args.indexOf("bash");
      expect(tIdx).toBeLessThan(cmdIdx);
    });

    it("omits -t flag when targetPaneId is not provided", async () => {
      const { calls, fn } = captureExec();
      const execFn: ExecFn = async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: "%5\n", stderr: "", code: 0 };
      };
      const client = new TmuxClient(execFn);
      await client.splitWindow("right", "bash");
      expect(calls[0].args).not.toContain("-t");
    });

    it("returns trimmed pane ID from stdout", async () => {
      const client = new TmuxClient(mockExec({ stdout: "%5\n", stderr: "", code: 0 }));
      const id = await client.splitWindow("right", "bash");
      expect(id).toBe("%5");
    });

    it("throws TmuxError with code SPLIT_FAILED on non-zero exit", async () => {
      const client = new TmuxClient(
        mockExec({ stdout: "", stderr: "no space for new pane", code: 1 }),
      );
      await expect(client.splitWindow("right", "bash")).rejects.toMatchObject({
        name: "TmuxError",
        code: "SPLIT_FAILED",
      });
    });
  });

  // ─── sendKeys ───────────────────────────────────────────────

  describe("sendKeys()", () => {
    it("sends text + Enter in a single bash exec using positional params", async () => {
      const { calls, fn } = captureExec();
      const client = new TmuxClient(fn);
      await client.sendKeys("%3", "hello world");
      expect(calls.length).toBe(1);
      expect(calls[0].cmd).toBe("bash");
      expect(calls[0].args[0]).toBe("-c");
      // Script uses positional params — paneId and text are separate args, not interpolated
      expect(calls[0].args).toContain("%3");
      expect(calls[0].args).toContain("hello world");
    });

    it("passes text containing special characters safely via positional params", async () => {
      const { calls, fn } = captureExec();
      const client = new TmuxClient(fn);
      const tricky = `it's a "test" with $vars and \\backslashes`;
      await client.sendKeys("%3", tricky);
      expect(calls[0].args).toContain(tricky); // passed as arg, not shell-interpolated
    });

    it("throws TmuxError with code SEND_FAILED on non-zero exit", async () => {
      const client = new TmuxClient(
        mockExec({ stdout: "", stderr: "pane not found", code: 1 }),
      );
      await expect(client.sendKeys("%3", "test")).rejects.toMatchObject({
        name: "TmuxError",
        code: "SEND_FAILED",
      });
    });
  });

  // ─── setupPane ──────────────────────────────────────────────

  describe("setupPane()", () => {
    it("sends a single bash exec with paneId and title as positional params", async () => {
      const { calls, fn } = captureExec();
      const client = new TmuxClient(fn);
      await client.setupPane("%5", "my-label");
      expect(calls.length).toBe(1);
      expect(calls[0].cmd).toBe("tmux");
      expect(calls[0].args).toEqual(["select-pane", "-t", "%5", "-T", "my-label"]);
    });

    it("does not throw on failure (best-effort)", async () => {
      const client = new TmuxClient(
        mockExec({ stdout: "", stderr: "failed", code: 1 }),
      );
      await expect(client.setupPane("%5", "label")).resolves.toBeUndefined();
    });
  });

  // ─── capturePaneWithStatus ───────────────────────────────────

  describe("capturePaneWithStatus()", () => {
    it("returns content and alive=true on success", async () => {
      const client = new TmuxClient(
        mockExec({ stdout: "line1\nline2\n", stderr: "", code: 0 }),
      );
      const result = await client.capturePaneWithStatus("%5");
      expect(result.alive).toBe(true);
      expect(result.content).toBe("line1\nline2\n");
    });

    it("returns alive=false and empty content on non-zero exit (pane dead)", async () => {
      const client = new TmuxClient(
        mockExec({ stdout: "", stderr: "pane not found", code: 1 }),
      );
      const result = await client.capturePaneWithStatus("%99");
      expect(result.alive).toBe(false);
      expect(result.content).toBe("");
    });

    it("issues a single tmux capture-pane exec", async () => {
      const { calls, fn } = captureExec();
      const client = new TmuxClient(fn);
      await client.capturePaneWithStatus("%5");
      expect(calls.length).toBe(1);
      expect(calls[0].cmd).toBe("tmux");
      expect(calls[0].args).toEqual(["capture-pane", "-p", "-t", "%5"]);
    });
  });

  // ─── killPane ───────────────────────────────────────────────

  describe("killPane()", () => {
    it("sends correct tmux kill-pane command", async () => {
      const { calls, fn } = captureExec();
      const execFn: ExecFn = async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: "", stderr: "", code: 0 };
      };
      const client = new TmuxClient(execFn);
      await client.killPane("%7");
      expect(calls[0].cmd).toBe("tmux");
      expect(calls[0].args).toEqual(["kill-pane", "-t", "%7"]);
    });

    it("silently handles 'pane not found' error (no throw)", async () => {
      const client = new TmuxClient(
        mockExec({ stdout: "", stderr: "no pane with id %99", code: 1 }),
      );
      await expect(client.killPane("%99")).resolves.toBeUndefined();
    });

    it("silently handles 'not found' in stderr", async () => {
      const client = new TmuxClient(
        mockExec({ stdout: "not found", stderr: "", code: 1 }),
      );
      await expect(client.killPane("%99")).resolves.toBeUndefined();
    });

    it("throws TmuxError with code KILL_FAILED on other non-zero exits", async () => {
      const client = new TmuxClient(
        mockExec({ stdout: "", stderr: "some unexpected error", code: 1 }),
      );
      await expect(client.killPane("%5")).rejects.toMatchObject({
        name: "TmuxError",
        code: "KILL_FAILED",
      });
    });
  });

  // ─── setPaneTitle ───────────────────────────────────────────

  describe("setPaneTitle()", () => {
    it("sends correct tmux select-pane command", async () => {
      const { calls, fn } = captureExec();
      const execFn: ExecFn = async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: "", stderr: "", code: 0 };
      };
      const client = new TmuxClient(execFn);
      await client.setPaneTitle("%5", "my-label");
      expect(calls[0].cmd).toBe("tmux");
      expect(calls[0].args).toEqual(["select-pane", "-t", "%5", "-T", "my-label"]);
    });

    it("does not throw on failure (best-effort)", async () => {
      const client = new TmuxClient(
        mockExec({ stdout: "", stderr: "failed", code: 1 }),
      );
      await expect(client.setPaneTitle("%5", "label")).resolves.toBeUndefined();
    });
  });

  // ─── listPanes ──────────────────────────────────────────────

  describe("listPanes()", () => {
    it("sends correct tmux list-panes command", async () => {
      const { calls, fn } = captureExec();
      const execFn: ExecFn = async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: "%0\n%1\n%2\n", stderr: "", code: 0 };
      };
      const client = new TmuxClient(execFn);
      const panes = await client.listPanes();
      expect(calls[0].cmd).toBe("tmux");
      expect(calls[0].args).toEqual(["list-panes", "-a", "-F", "#{pane_id}"]);
      expect(panes).toEqual(["%0", "%1", "%2"]);
    });

    it("returns empty array on non-zero exit", async () => {
      const client = new TmuxClient(
        mockExec({ stdout: "", stderr: "no server", code: 1 }),
      );
      const panes = await client.listPanes();
      expect(panes).toEqual([]);
    });

    it("filters empty lines", async () => {
      const client = new TmuxClient(
        mockExec({ stdout: "%0\n\n%1\n", stderr: "", code: 0 }),
      );
      const panes = await client.listPanes();
      expect(panes).toEqual(["%0", "%1"]);
    });
  });

  // ─── isPaneAlive ────────────────────────────────────────────

  describe("isPaneAlive()", () => {
    it("returns true when pane is in list", async () => {
      const client = new TmuxClient(
        mockExec({ stdout: "%0\n%3\n%5\n", stderr: "", code: 0 }),
      );
      expect(await client.isPaneAlive("%3")).toBe(true);
    });

    it("returns false when pane is not in list", async () => {
      const client = new TmuxClient(
        mockExec({ stdout: "%0\n%1\n", stderr: "", code: 0 }),
      );
      expect(await client.isPaneAlive("%99")).toBe(false);
    });
  });

  // ─── capturePaneContent ─────────────────────────────────────

  describe("capturePaneContent()", () => {
    it("sends correct capture-pane args and returns stdout", async () => {
      const { calls, fn } = captureExec();
      const execFn: ExecFn = async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: "line1\nline2\n", stderr: "", code: 0 };
      };
      const client = new TmuxClient(execFn);
      const content = await client.capturePaneContent("%5");
      expect(calls[0].cmd).toBe("tmux");
      expect(calls[0].args).toEqual(["capture-pane", "-p", "-t", "%5"]);
      expect(content).toBe("line1\nline2\n");
    });

    it("throws TmuxError with code CAPTURE_FAILED on non-zero exit", async () => {
      const client = new TmuxClient(
        mockExec({ stdout: "", stderr: "pane not found", code: 1 }),
      );
      await expect(client.capturePaneContent("%99")).rejects.toMatchObject({
        name: "TmuxError",
        code: "CAPTURE_FAILED",
      });
    });

    it("returns stdout even when it is empty (pane exists, no output yet)", async () => {
      const client = new TmuxClient(
        mockExec({ stdout: "", stderr: "", code: 0 }),
      );
      const content = await client.capturePaneContent("%3");
      expect(content).toBe("");
    });
  });

});
