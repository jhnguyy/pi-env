import { expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { getRegisteredActions } from "../action-registry";
import {
  DEV_TOOLS_ACTION_CONTRACTS,
  DEV_TOOLS_ACTIONS,
  DEV_TOOLS_TOOL_DESCRIPTIONS,
  DevToolsAction,
  DevToolsPathMode,
  createDevToolsParameterSchema,
} from "../action-contract";
import { StringEnum } from "@earendil-works/pi-ai";
import "../register-actions";

describeIfEnabled("dev-tools", "action contract", () => {
  it("keeps the public action list, contracts, and daemon registry in sync", () => {
    expect(Object.keys(DEV_TOOLS_ACTION_CONTRACTS).sort()).toEqual([...DEV_TOOLS_ACTIONS].sort());
    expect(getRegisteredActions().sort()).toEqual([...DEV_TOOLS_ACTIONS].sort());
  });

  it("defines request requirements in one public contract table", () => {
    expect(DEV_TOOLS_ACTION_CONTRACTS[DevToolsAction.Diagnostics]).toMatchObject({ pathMode: DevToolsPathMode.Many, requiresPath: true });
    expect(DEV_TOOLS_ACTION_CONTRACTS[DevToolsAction.Status]).toMatchObject({ pathMode: DevToolsPathMode.None, requiresPath: false, needsPosition: false });
    expect(DEV_TOOLS_ACTION_CONTRACTS[DevToolsAction.References]).toMatchObject({ pathMode: DevToolsPathMode.Single, requiresPath: true, needsPosition: true });
    expect(DEV_TOOLS_ACTION_CONTRACTS[DevToolsAction.Symbols]).toMatchObject({ pathMode: DevToolsPathMode.Single, requiresPath: false, requiresPathOrQuery: true });
  });

  it("builds the tool schema from shared parameter descriptions", () => {
    const schema = createDevToolsParameterSchema(
      StringEnum(DEV_TOOLS_ACTIONS, { description: DEV_TOOLS_TOOL_DESCRIPTIONS.action }),
    );
    const properties = schema.properties as Record<string, any>;

    expect(properties.action.description).toBe(DEV_TOOLS_TOOL_DESCRIPTIONS.action);
    expect(properties.path.description).toBe(DEV_TOOLS_TOOL_DESCRIPTIONS.path);
    expect(properties.line.minimum).toBe(1);
    expect(properties.line.description).toBe(DEV_TOOLS_TOOL_DESCRIPTIONS.line);
    expect(properties.character.minimum).toBe(1);
    expect(properties.character.description).toBe(DEV_TOOLS_TOOL_DESCRIPTIONS.character);
    expect(properties.query.description).toBe(DEV_TOOLS_TOOL_DESCRIPTIONS.query);
  });
});
