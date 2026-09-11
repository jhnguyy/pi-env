import initSubagent from "../index";
import type { SubagentSessionRuntimeDependencies } from "../session-runtime";

export function createSubagentHarness(dependencies: SubagentSessionRuntimeDependencies = {}) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const pi = {
    appendEntry: () => {},
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    events: {
      emit: () => {},
      on: () => {},
    },
  };
  initSubagent(pi as any, dependencies);
  return { tools, handlers };
}
