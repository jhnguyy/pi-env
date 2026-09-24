import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
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
      writeFileSync(executable, `#!${resolveNodeCommand()}\nconst { spawnSync } = require('node:child_process');\nconst { readFileSync } = require('node:fs');\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['read', '--no-newline', 'op://Private/Canary/credential'])) process.exit(2);\nconst group = (pid) => process.platform === 'linux'\n  ? readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ').at(-1).split(' ')[2]\n  : spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout?.trim();\nif (!group(process.pid) || group(process.pid) !== group(process.ppid)) process.exit(3);\nprocess.stdout.write('SECRET_SENTINEL_DO_NOT_LEAK');\n`);
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
