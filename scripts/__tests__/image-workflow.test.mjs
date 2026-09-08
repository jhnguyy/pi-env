import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT =
  process.env.PI_ENV_IMAGE_WORKFLOW_ROOT ?? fileURLToPath(new URL("../..", import.meta.url));
const WORKFLOW = readFileSync(`${ROOT}/.github/workflows/image.yml`, "utf8");
const QUALIFICATION_ACTION = readFileSync(
  `${ROOT}/.github/actions/qualify-image/action.yml`,
  "utf8",
);

function job(name, nextName) {
  const start = WORKFLOW.indexOf(`\n  ${name}:`);
  const end = nextName ? WORKFLOW.indexOf(`\n  ${nextName}:`, start + 1) : WORKFLOW.length;
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return WORKFLOW.slice(start, end);
}

describe("container image workflow", () => {
  it("publishes the same local image candidate that passed qualification", () => {
    const publish = job("publish");

    expect(QUALIFICATION_ACTION.match(/\bdocker build\b/g)).toHaveLength(1);
    expect(WORKFLOW).not.toContain("docker/setup-buildx-action");
    expect(WORKFLOW).not.toContain("docker/build-push-action");
    expect(publish.match(/uses: \.\/\.github\/actions\/qualify-image/g)).toHaveLength(1);
    expect(publish).toContain("EXPECTED_IMAGE_ID: ${{ steps.qualified-image.outputs.image-id }}");
    expect(publish).toContain('actual_image_id="$(docker image inspect');
    expect(publish.indexOf("Qualify image candidate")).toBeLessThan(
      publish.indexOf("Authenticate publisher with GHCR"),
    );
    expect(publish.indexOf("Authenticate publisher with GHCR")).toBeLessThan(
      publish.indexOf("Publish verified image to GHCR"),
    );
  });

  it("keeps package write authority out of pull-request verification", () => {
    const workflowDefaults = WORKFLOW.slice(0, WORKFLOW.indexOf("\njobs:"));
    const verify = job("verify", "publish");
    const publish = job("publish");

    expect(workflowDefaults).toContain("permissions:\n  contents: read");
    expect(WORKFLOW.match(/persist-credentials: false/g)).toHaveLength(2);
    expect(verify).toContain("if: github.event_name == 'pull_request'");
    expect(verify).not.toContain("packages: write");
    expect(publish).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(publish).toContain("packages: write");
  });

  it("does not cancel an active main-branch publication", () => {
    expect(WORKFLOW).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });

  it("provides notification-safe labels for each failure boundary", () => {
    expect(WORKFLOW).toContain("Publish verified pi-env image to GHCR");
    expect(WORKFLOW).toContain("Verify pi-env image artifact");

    for (const title of [
      "Container image build failed",
      "Container artifact verification failed",
      "Container image scanner failed",
      "Container image security policy failed",
    ]) {
      expect(QUALIFICATION_ACTION).toContain(`::error title=${title}::`);
    }

    expect(WORKFLOW).toContain("Authenticate publisher with GHCR");
    expect(WORKFLOW).toContain("::error title=Container candidate identity changed::");
    expect(WORKFLOW).toContain("::error title=Container image publication failed::");
  });
});
