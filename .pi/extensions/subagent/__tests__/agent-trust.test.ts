import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import * as Resolver from "../resolver";

// Canonical path and session-only decisions are not independently configurable
// through the SDK's persisted trust UI in print-mode integration tests.
it("limits session trust to the canonical parent cwd and honors saved target decisions", () => {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "native-target-trust-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", Path.join(root, "agent"));
  try {
    const parent = Path.join(root, "parent");
    const target = Path.join(root, "target");
    const alias = Path.join(root, "alias");
    Fs.mkdirSync(parent);
    Fs.mkdirSync(target);
    Fs.symlinkSync(parent, alias);
    const ctx = { cwd: alias, isProjectTrusted: () => true };
    expect(Resolver.isProjectTrustedForCwd(ctx, parent)).toBe(true);
    expect(Resolver.isProjectTrustedForCwd({ ...ctx, isProjectTrusted: () => false }, parent)).toBe(false);
    expect(Resolver.isProjectTrustedForCwd(ctx, target)).toBe(false);
    const store = new ProjectTrustStore(getAgentDir());
    store.set(target, true);
    expect(Resolver.isProjectTrustedForCwd(ctx, target)).toBe(true);
    store.set(target, false);
    expect(Resolver.isProjectTrustedForCwd(ctx, target)).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    Fs.rmSync(root, { recursive: true, force: true });
  }
});
