import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discoverAgents } from "../agents";
import {
  ResolutionErrorReason,
  ResolutionResultTag,
  resolveSubagentExecutionPlan,
} from "../resolver";

const roots: string[] = [];
beforeEach(() => vi.stubEnv("PI_CODING_AGENT_DIR", root()));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "pi-subagent-agent-trust-"));
  roots.push(path);
  return path;
}

function writeAgent(directory: string, name: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} agent\ncapabilities: read\nmodel: test/model\n---\nRead only.\n`,
  );
}

function context(cwd: string, trusted: boolean) {
  return {
    cwd,
    isProjectTrusted: () => trusted,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === "test" && id === "model" ? { provider, id } : undefined,
      getAvailable: () => [{ provider: "test", id: "model" }],
    },
  } as any;
}

describe("subagent agent source and trust policy", () => {
  it("requires explicit scope and project trust for project agents", () => {
    const cwd = root();
    writeAgent(join(cwd, ".pi", "agents"), "project-only");

    const implicit = resolveSubagentExecutionPlan(
      { name: "implicit", agent: "project-only", task: "task" },
      context(cwd, true),
      new Map(),
    );
    expect(implicit._tag).toBe(ResolutionResultTag.Error);
    if (implicit._tag === ResolutionResultTag.Error) {
      expect(implicit.error.reason).toBe(ResolutionErrorReason.AgentNotFound);
    }

    const untrusted = resolveSubagentExecutionPlan(
      {
        name: "untrusted",
        agent: "project-only",
        agent_scope: "project",
        task: "task",
      },
      context(cwd, false),
      new Map(),
    );
    expect(untrusted._tag).toBe(ResolutionResultTag.Error);
    if (untrusted._tag === ResolutionResultTag.Error) {
      expect(untrusted.error.reason).toBe(ResolutionErrorReason.UntrustedProjectAgent);
    }

    const trusted = resolveSubagentExecutionPlan(
      {
        name: "trusted",
        agent: "project-only",
        agent_scope: "project",
        task: "task",
      },
      context(cwd, true),
      new Map(),
    );
    expect(trusted._tag).toBe(ResolutionResultTag.Ok);
  });

  it("does not transfer session-only project trust to a different workspace", () => {
    const parent = root();
    const target = root();
    writeAgent(join(target, ".pi", "agents"), "target-agent");
    const result = resolveSubagentExecutionPlan(
      { name: "target", task: "task", agent: "target-agent", agent_scope: "project", cwd: target },
      context(parent, true),
      new Map(),
    );
    expect(result._tag).toBe(ResolutionResultTag.Error);
    if (result._tag === ResolutionResultTag.Error) {
      expect(result.error.reason).toBe(ResolutionErrorReason.UntrustedProjectAgent);
    }
  });

  it("uses native saved trust for a different target workspace", () => {
    const parent = root();
    const target = root();
    writeAgent(join(target, ".pi", "agents"), "saved-trust-agent");
    const store = new ProjectTrustStore(getAgentDir());
    const resolve = () => resolveSubagentExecutionPlan(
      { name: "target", task: "task", agent: "saved-trust-agent", agent_scope: "project", cwd: target },
      context(parent, true),
      new Map(),
    );
    store.set(target, true);
    expect(resolve()._tag).toBe(ResolutionResultTag.Ok);
    store.set(target, false);
    const denied = resolve();
    expect(denied._tag).toBe(ResolutionResultTag.Error);
    if (denied._tag === ResolutionResultTag.Error) {
      expect(denied.error.reason).toBe(ResolutionErrorReason.UntrustedProjectAgent);
    }
  });

  it("preserves global/project package source authority with relative settings paths", () => {
    const cwd = root();
    writeAgent(join(getAgentDir(), "global-package", ".pi", "agents"), "global-package-agent");
    writeAgent(join(cwd, ".pi", "project-package", ".pi", "agents"), "project-package-agent");
    writeAgent(join(cwd, ".pi", "agents"), "project-agent");
    writeFileSync(join(getAgentDir(), "settings.json"), JSON.stringify({ packages: ["./global-package"] }));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["./project-package"] }));

    expect(discoverAgents(cwd, "user").agents).toEqual([
      expect.objectContaining({ name: "global-package-agent", source: "package" }),
    ]);
    expect(discoverAgents(cwd, "project").agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "project-package-agent", source: "project" }),
      expect.objectContaining({ name: "project-agent", source: "project" }),
    ]));
    const resolve = (agent: string, trusted: boolean, agent_scope?: "project") =>
      resolveSubagentExecutionPlan({ name: "package", task: "task", agent, agent_scope },
        context(cwd, trusted), new Map());
    expect(resolve("global-package-agent", false)._tag).toBe(ResolutionResultTag.Ok);
    const denied = resolve("project-package-agent", false, "project");
    expect(denied._tag).toBe(ResolutionResultTag.Error);
    if (denied._tag === ResolutionResultTag.Error) {
      expect(denied.error.reason).toBe(ResolutionErrorReason.UntrustedProjectAgent);
    }
    expect(resolve("project-package-agent", true, "project")._tag).toBe(ResolutionResultTag.Ok);
  });
});
