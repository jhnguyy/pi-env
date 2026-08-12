import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { discoverAgents } from "../agents";
import {
  ResolutionErrorReason,
  ResolutionResultTag,
  resolveSubagentExecutionPlan,
} from "../resolver";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

  it("keeps default and project scopes distinct", () => {
    const cwd = root();
    const packageRoot = root();
    writeAgent(join(packageRoot, ".pi", "agents"), "package-agent");
    writeAgent(join(cwd, ".pi", "agents"), "project-agent");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [packageRoot] }));

    const defaultAgents = discoverAgents(cwd, "user");
    expect(defaultAgents.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "package-agent", source: "package" }),
      ]),
    );
    expect(defaultAgents.agents.some((agent) => agent.name === "project-agent")).toBe(false);

    const projectAgents = discoverAgents(cwd, "project");
    expect(projectAgents.agents).toEqual([
      expect.objectContaining({ name: "project-agent", source: "project" }),
    ]);
  });
});
