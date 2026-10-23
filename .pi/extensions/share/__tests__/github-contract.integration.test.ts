import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { exampleShare, privateRepository } from "./fixture";

const run = promisify(execFile);
const enabled = process.env["PI_ENV_SHARE_GITHUB_CONTRACT"] === "1";

// Read-only change detector for the real gh envelope and GitHub DTOs behind fixture.ts.
// Mutation and private-Pages scenarios remain synthetic; their sources are identified there.
it.skipIf(!enabled)("corroborates the GitHub fixture with real read-only responses", async () => {
  const parent = process.env["PI_ENV_E2E_ARTIFACT_DIR"] ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const artifact = join(mkdtempSync(join(parent, "pi-share-contract-")), "result.json");
  const observations: Array<{ endpoint: string; status: number; exitCode: number; fields: Record<string, string> }> = [];
  let verdict = "fail";
  let cliVersion = "unavailable";
  try {
    cliVersion = (await run("gh", ["--version"], { timeout: 4000 })).stdout.split("\n")[0];
    const repository = "repos/jhnguyy/pi-env";
    for (const endpoint of [repository, `${repository}/branches/main`, `${repository}/contents?ref=main`, `${repository}/contents/LICENSE?ref=main`, `${repository}/pages`]) {
      const args = ["api", "--hostname", "github.com", "--include", "--method", "GET", endpoint];
      if (endpoint.includes("/contents/")) args.push("-H", "Accept: application/vnd.github.object+json");
      // gh exits nonzero for a genuine 404, but still returns its HTTP envelope.
      const response = await run("gh", args, { timeout: 4000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_DEBUG: "" } }).then(({ stdout }) => ({ stdout, exitCode: 0 })).catch((error: unknown) => {
        if (typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string" && "code" in error && typeof error.code === "number") return { stdout: error.stdout, exitCode: error.code };
        throw error;
      });
      const envelope = /^HTTP\/\d+(?:\.\d+)? ([1-5]\d{2})[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n/.exec(response.stdout);
      expect(envelope, "real gh must supply the fixture's status/header/body envelope").not.toBeNull();
      const status = Number(envelope![1]);
      const fields: Record<string, string> = {};
      observations.push({ endpoint, status, exitCode: response.exitCode, fields });
      expect(response.exitCode).toBe(status >= 400 ? 1 : 0);
      const body = JSON.parse(response.stdout.slice(envelope![0].length));
      if (endpoint === repository) {
        expect(status).toBe(200);
        for (const [key, value] of Object.entries(privateRepository)) {
          fields[key] = typeof body[key];
          expect(typeof body[key], key).toBe(typeof value);
        }
        fields["permissions.push"] = typeof body.permissions?.push;
        expect(fields["permissions.push"]).toBe("boolean");
      } else if (endpoint.includes("/branches/")) {
        expect(status).toBe(200);
        fields["name"] = typeof body.name;
        expect(body.name).toBe("main");
      } else if (endpoint.includes("/contents")) {
        expect(status).toBe(200);
        expect(Array.isArray(body)).toBe(!endpoint.includes("/contents/"));
        const file = Array.isArray(body) ? body.find((entry: Record<string, unknown>) => entry["type"] === "file") : body;
        expect(file).toBeDefined();
        for (const [key, value] of Object.entries(exampleShare)) {
          fields[key] = typeof file[key];
          expect(typeof file[key], key).toBe(typeof value);
        }
      } else {
        expect([200, 404]).toContain(status);
        if (status === 200) {
          fields["public"] = typeof body.public;
          fields["html_url"] = typeof body.html_url;
          expect(fields).toEqual({ public: "boolean", html_url: "string" });
        }
      }
    }
    verdict = "pass";
  } finally {
    writeFileSync(artifact, JSON.stringify({
      inputs: { cliVersion, requests: "GET-only repository, branch, directory and license-file metadata, and Pages" },
      expected: "HTTP envelopes and DTO field types agree with the workflow fixture",
      actual: observations, verdict,
      limits: "No mutation or private Pages deployment is exercised. Only status and field types are retained; response bodies and headers are not recorded.",
      reproduce: "PI_ENV_SHARE_GITHUB_CONTRACT=1 nub run test:vitest .pi/extensions/share/__tests__/github-contract.integration.test.ts",
    }, null, 2));
    console.info(`Share GitHub contract evidence: ${artifact}`);
  }
});
