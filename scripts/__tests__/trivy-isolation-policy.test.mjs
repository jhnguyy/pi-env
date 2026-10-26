import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

// Static policy checks complement the real archive transfer in GitHub Actions.
describe("Trivy publication isolation policy", () => {
  it("qualifies the candidate without publication permission", () => {
    const workflow = source(".github/workflows/image.yml");
    const qualify = workflow.split("  qualify:\n")[1]?.split("  publish:\n")[0];
    expect(qualify).toBeDefined();
    expect(qualify).toContain("contents: read");
    expect(qualify).not.toContain("packages: write");
    expect(qualify).toContain("uses: ./.github/actions/qualify-image");
    expect(qualify).toContain("uses: actions/upload-artifact@");
  });

  it("publishes only the transferred candidate after digest and image identity checks", () => {
    const workflow = source(".github/workflows/image.yml");
    const publish = workflow.split("  publish:\n")[1];
    expect(publish).toContain("needs: qualify");
    expect(publish).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(publish).toContain("packages: write");
    expect(publish).toContain("uses: actions/download-artifact@");
    expect(publish).not.toContain("actions/checkout@");
    expect(publish).not.toContain("./.github/actions/qualify-image");
    expect(publish).not.toMatch(/docker (?:build|run)\b/);
    expect(publish).toContain("needs.qualify.outputs.archive-sha256");
    expect(publish).toContain("needs.qualify.outputs.image-id");
    const hash = publish.indexOf("sha256sum --check --strict");
    const load = publish.indexOf("docker load");
    const identity = publish.indexOf('actual_image_id="$(docker image inspect');
    const login = publish.indexOf("uses: docker/login-action@");
    const push = publish.indexOf("docker push");
    expect(hash).toBeGreaterThan(0);
    expect(load).toBeGreaterThan(hash);
    expect(identity).toBeGreaterThan(load);
    expect(login).toBeGreaterThan(identity);
    expect(push).toBeGreaterThan(login);
  });

  it("does not offer automatic host execution", () => {
    const script = source("scripts/trivy-scan.sh");
    expect(script).not.toContain("run_local");
    expect(script).not.toMatch(/exec trivy\b/);
    expect(script).toContain('trivy-snapshot.sh" "$SCAN_ROOT"');
    expect(script).toContain('-v "$SCAN_ROOT:/work:ro"');
    expect(script).toContain("--user");
  });
});
