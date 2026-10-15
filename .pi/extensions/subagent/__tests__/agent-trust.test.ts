import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
    expect(resolve()._tag).toBe(ResolutionResultTag.Error);
  });

  it("keeps user-installed package agents in default scope", () => {
    const cwd = root();
    const packageRoot = root();
    writeAgent(join(packageRoot, ".pi", "agents"), "user-package-agent");
    writeFileSync(join(getAgentDir(), "settings.json"), JSON.stringify({ packages: [packageRoot] }));
    expect(discoverAgents(cwd, "user").agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "user-package-agent", source: "package" }),
    ]));
  });

  it("resolves project package paths from the target settings directory, not the process directory", () => {
    const cwd = root();
    const relative = `./${basename(cwd)}`;
    const packageRoot = join(cwd, ".pi", relative);
    const decoy = join(process.cwd(), relative);
    roots.push(decoy);
    writeAgent(join(packageRoot, ".pi", "agents"), "target-relative-agent");
    writeAgent(join(decoy, ".pi", "agents"), "parent-decoy-agent");
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [relative] }));
    const agents = discoverAgents(cwd, "project").agents;
    expect(agents.some((agent) => agent.name === "target-relative-agent")).toBe(true);
    expect(agents.some((agent) => agent.name === "parent-decoy-agent")).toBe(false);
  });

  it("resolves global package paths from the native agent directory", () => {
    const cwd = root();
    const packageRoot = join(getAgentDir(), "relative-user-package");
    writeAgent(join(packageRoot, ".pi", "agents"), "relative-user-agent");
    writeFileSync(join(getAgentDir(), "settings.json"), JSON.stringify({ packages: ["./relative-user-package"] }));
    expect(discoverAgents(cwd, "user").agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "relative-user-agent", source: "package" }),
    ]));
  });

  it("keeps project packages out of user scope and discovers them in explicit project scope", () => {
    const cwd = root();
    const packageRoot = root();
    writeAgent(join(packageRoot, ".pi", "agents"), "package-agent");
    writeAgent(join(cwd, ".pi", "agents"), "project-agent");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [packageRoot] }));

    const defaultAgents = discoverAgents(cwd, "user");
    expect(defaultAgents.agents.some((agent) => agent.name === "package-agent")).toBe(false);
    expect(defaultAgents.agents.some((agent) => agent.name === "project-agent")).toBe(false);

    const projectAgents = discoverAgents(cwd, "project");
    expect(projectAgents.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "package-agent", source: "project" }),
      expect.objectContaining({ name: "project-agent", source: "project" }),
    ]));
  });
});
