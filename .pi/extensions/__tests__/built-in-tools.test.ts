import { describe, expect, it } from "vitest";

import { BUILT_IN_TOOL_CONTRACTS, BUILT_IN_TOOL_NAMES } from "../_shared/built-in-tools";
import { ToolCapability } from "../_shared/agent-tools";
import { BUILT_IN_TOOLS } from "../subagent/resolver";

const EXPECTED_CAPABILITIES = {
  read: [ToolCapability.Read],
  bash: [ToolCapability.Read, ToolCapability.Write, ToolCapability.Execute],
  edit: [ToolCapability.Write],
  write: [ToolCapability.Write],
  grep: [ToolCapability.Read],
  find: [ToolCapability.Read],
  ls: [ToolCapability.Read],
};
const EXPECTED_NAMES = Object.keys(EXPECTED_CAPABILITIES).sort();

describe("shared built-in tool catalog", () => {
  it("instantiates equivalent AgentTool and ToolDefinition factories for every catalog key", () => {
    for (const [key, contract] of Object.entries(BUILT_IN_TOOL_CONTRACTS)) {
      const agentTool = contract.agentFactory("/tmp/project");
      const definition = contract.definitionFactory("/tmp/project");

      expect(agentTool.name).toBe(key);
      expect(definition.name).toBe(key);
      expect(agentTool.name).toBe(definition.name);
      expect(agentTool.label).toBe(definition.label);
      expect(agentTool.description).toBe(definition.description);
      expect(agentTool.parameters).toBe(definition.parameters);
      expect(agentTool.prepareArguments).toBe(definition.prepareArguments);
      expect(agentTool.executionMode).toBe(definition.executionMode);
    }
  });

  it("derives capabilities and consumer name sets from the catalog", () => {
    expect([...BUILT_IN_TOOL_NAMES].sort()).toEqual(EXPECTED_NAMES);
    expect(Object.keys(BUILT_IN_TOOLS).sort()).toEqual(Object.keys(BUILT_IN_TOOL_CONTRACTS).sort());

    for (const [name, capabilities] of Object.entries(EXPECTED_CAPABILITIES)) {
      const contract = BUILT_IN_TOOL_CONTRACTS[name as keyof typeof BUILT_IN_TOOL_CONTRACTS];
      expect(contract.capabilities).toEqual(capabilities);
      expect(BUILT_IN_TOOLS[name].capabilities).toEqual(capabilities);
    }
  });
});
