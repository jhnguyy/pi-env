import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CredentialErrorCode } from "../../_shared/credential-source";
import { ProcessFailure, ProcessFailureKind, resolveNodeCommand } from "../../../../src/process/platform";
import {
  CREDENTIAL_STDERR_LIMIT_BYTES,
  CREDENTIAL_STDOUT_LIMIT_BYTES,
  createBitwardenProvider,
  createOnePasswordProvider,
  type BitwardenSessionSource,
  type CredentialProcessRunner,
} from "../providers";

const SENTINEL = "SECRET_SENTINEL_DO_NOT_LEAK";
const itemId = "12345678-1234-1234-1234-123456789abc";

describe("credential providers", () => {
  it.runIf(process.platform !== "win32")("inherits the caller's process group for a fixed 1Password read", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-credential-op-"));
    try {
      const executable = join(directory, "op");
      writeFileSync(executable, `#!${resolveNodeCommand()}
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");

if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify([
  "read", "--no-newline", "op://Private/Canary/credential",
])) process.exit(2);

function processGroup(pid) {
  if (process.platform === "linux") {
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[2];
  }
  return spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout?.trim();
}
if (!processGroup(process.pid) || processGroup(process.pid) !== processGroup(process.ppid)) {
  process.exit(3);
}
process.stdout.write("SECRET_SENTINEL_DO_NOT_LEAK");
`);
      chmodSync(executable, 0o700);
      const provider = createOnePasswordProvider(undefined, () => executable);
      const result = await Effect.runPromise(provider.resolve({
        provider: "1password", consumers: ["linear"], reference: "op://Private/Canary/credential",
      }, "linear.apiKey"));
      expect(Redacted.value(result)).toBe(SENTINEL);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.runIf(process.platform !== "win32")("does not overlap 1Password reads across provider instances", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-credential-parallel-"));
    const marker = join(directory, "active");
    const overlap = join(directory, "overlap");
    try {
      const executable = join(directory, "op");
      writeFileSync(executable, `#!${resolveNodeCommand()}
const { closeSync, openSync, unlinkSync, writeFileSync } = require("node:fs");
const marker = ${JSON.stringify(marker)};
const overlap = ${JSON.stringify(overlap)};
let owned = false;
try {
  closeSync(openSync(marker, "wx"));
  owned = true;
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  writeFileSync(overlap, "overlap");
}
setTimeout(() => {
  if (owned) unlinkSync(marker);
  process.stdout.write("SECRET_SENTINEL_DO_NOT_LEAK");
}, 300);
`);
      chmodSync(executable, 0o700);
      const firstProvider = createOnePasswordProvider(undefined, () => executable);
      const secondProvider = createOnePasswordProvider(undefined, () => executable);
      const entry = {
        provider: "1password" as const,
        consumers: ["linear"],
        reference: "op://Private/Canary/credential",
      };
      const [first, second] = await Promise.all([
        Effect.runPromise(firstProvider.resolve(entry, "linear.apiKey")),
        Effect.runPromise(secondProvider.resolve(entry, "linear.apiKey")),
      ]);
      expect(Redacted.value(first)).toBe(SENTINEL);
      expect(Redacted.value(second)).toBe(SENTINEL);
      expect(existsSync(overlap)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("releases the read permit after interruption", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-credential-interrupt-"));
    const pidFile = join(directory, "first-pid");
    const executable = join(directory, "op");
    writeFileSync(executable, `#!${resolveNodeCommand()}
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const pidFile = ${JSON.stringify(pidFile)};
if (!existsSync(pidFile)) {
  writeFileSync(pidFile, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  try {
    process.kill(Number(readFileSync(pidFile, "utf8")), 0);
    process.exit(3);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    process.stdout.write("SECRET_SENTINEL_DO_NOT_LEAK");
  }
}
`);
    chmodSync(executable, 0o700);
    const provider = createOnePasswordProvider(undefined, () => executable);
    const entry = {
      provider: "1password" as const,
      consumers: ["linear"],
      reference: "op://Private/Canary/credential",
    };
    const first = Effect.runFork(provider.resolve(entry, "linear.apiKey"));
    try {
      for (let index = 0; index < 120 && !existsSync(pidFile); index++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(existsSync(pidFile)).toBe(true);
      const second = Effect.runPromise(provider.resolve(entry, "linear.apiKey"));
      await Effect.runPromise(Fiber.interrupt(first));
      expect(Redacted.value(await second)).toBe(SENTINEL);
    } finally {
      await Effect.runPromise(Fiber.interrupt(first));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses a constrained 1Password CLI read with a fixed secret reference", async () => {
    const runner = vi.fn<CredentialProcessRunner>((_command, _args, _options) =>
      Effect.succeed({ stdout: SENTINEL, stderr: "" }),
    );
    const provider = createOnePasswordProvider(runner, () => "/trusted/op");
    const wrapped = await Effect.runPromise(
      provider.resolve(
        {
          provider: "1password",
          consumers: ["linear"],
          reference: "op://Private/Linear/credential",
        },
        "linear.apiKey",
      ),
    );

    const [command, args, options] = runner.mock.calls[0];
    expect(command).toBe("/trusted/op");
    expect(args).toEqual(["read", "--no-newline", "op://Private/Linear/credential"]);
    expect(options.env).not.toHaveProperty("PI_ENV_NODE_BIN");
    expect(options.stdoutLimitBytes).toBe(CREDENTIAL_STDOUT_LIMIT_BYTES);
    expect(options.stderrLimitBytes).toBe(CREDENTIAL_STDERR_LIMIT_BYTES);
    expect(Redacted.value(wrapped)).toBe(SENTINEL);
  });

  it("passes the Bitwarden session through runner stdin, not arguments or environment", async () => {
    const runner = vi.fn<CredentialProcessRunner>((_command, _args, _options) =>
      Effect.succeed({ stdout: `${SENTINEL}\n`, stderr: "" }),
    );
    const sessionSource: BitwardenSessionSource = {
      use: (consume) => consume(Redacted.make("SESSION_SENTINEL")),
    };
    const provider = createBitwardenProvider(
      sessionSource,
      "/trusted/bitwarden-runner.js",
      runner,
      () => "/trusted/bw",
    );
    const wrapped = await Effect.runPromise(
      provider.resolve(
        { provider: "bitwarden", consumers: ["linear"], itemId, field: "password" },
        "linear.apiKey",
      ),
    );

    const [command, args, options] = runner.mock.calls[0];
    expect(command).not.toContain("SESSION_SENTINEL");
    expect(args).toEqual(["/trusted/bitwarden-runner.js", "/trusted/bw", "password", itemId]);
    expect(JSON.stringify(args)).not.toContain("SESSION_SENTINEL");
    expect(JSON.stringify(options.env)).not.toContain("SESSION_SENTINEL");
    expect(options.env).not.toHaveProperty("PI_ENV_NODE_BIN");
    expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(Buffer.isBuffer(options.stdin)).toBe(true);
    expect(Buffer.from(options.stdin ?? "").toString("utf8")).toBe("SESSION_SENTINEL\n");
    expect(options.stdoutLimitBytes).toBe(CREDENTIAL_STDOUT_LIMIT_BYTES);
    expect(options.stderrLimitBytes).toBe(CREDENTIAL_STDERR_LIMIT_BYTES);
    expect(Redacted.value(wrapped)).toBe(SENTINEL);
  });

  it("sanitizes provider failures that contain credential material", async () => {
    const runner: CredentialProcessRunner = () =>
      Effect.fail(
        new ProcessFailure({
          kind: ProcessFailureKind.Exit,
          command: "bw",
          message: SENTINEL,
          stdout: SENTINEL,
          stderr: SENTINEL,
        }),
      );
    const sessionSource: BitwardenSessionSource = {
      use: (consume) => consume(Redacted.make("SESSION_SENTINEL")),
    };
    const provider = createBitwardenProvider(
      sessionSource,
      "/trusted/bitwarden-runner.js",
      runner,
      () => "/trusted/bw",
    );
    const result = await Effect.runPromise(
      Effect.result(
        provider.resolve(
          { provider: "bitwarden", consumers: ["linear"], itemId, field: "password" },
          "linear.apiKey",
        ),
      ),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.code).toBe(CredentialErrorCode.ProviderFailed);
      expect(JSON.stringify(result.failure)).not.toContain(SENTINEL);
    }
  });
});
