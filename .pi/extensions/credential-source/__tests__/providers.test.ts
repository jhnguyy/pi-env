import { Effect, Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CredentialErrorCode } from "../../_shared/credential-source";
import { ProcessFailure, ProcessFailureKind } from "../../../../src/process/platform";
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
  it("uses the 1Password desktop SDK with a fixed secret reference", async () => {
    const resolve = vi.fn(async () => SENTINEL);
    const createClient = vi.fn(async () => ({ secrets: { resolve } }));
    const provider = createOnePasswordProvider(createClient);
    const wrapped = await Effect.runPromise(
      provider.resolve(
        {
          provider: "1password",
          consumers: ["linear"],
          account: "Work",
          reference: "op://Private/Linear/credential",
        },
        "linear.apiKey",
      ),
    );

    expect(createClient).toHaveBeenCalledWith("Work");
    expect(resolve).toHaveBeenCalledWith("op://Private/Linear/credential");
    expect(Redacted.value(wrapped)).toBe(SENTINEL);
  });

  it("passes the Bitwarden session through runner stdin, not arguments or environment", async () => {
    const runner = vi.fn((_command, _args, _options) =>
      Effect.succeed({ stdout: `${SENTINEL}\n`, stderr: "" }),
    ) as unknown as CredentialProcessRunner;
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

    const [command, args, options] = (runner as any).mock.calls[0];
    expect(command).not.toContain("SESSION_SENTINEL");
    expect(args).toEqual(["/trusted/bitwarden-runner.js", "/trusted/bw", "password", itemId]);
    expect(JSON.stringify(args)).not.toContain("SESSION_SENTINEL");
    expect(JSON.stringify(options.env)).not.toContain("SESSION_SENTINEL");
    expect(options.env).not.toHaveProperty("PI_ENV_NODE_BIN");
    expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(Buffer.isBuffer(options.stdin)).toBe(true);
    expect(options.stdin.toString("utf8")).toBe("SESSION_SENTINEL\n");
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
