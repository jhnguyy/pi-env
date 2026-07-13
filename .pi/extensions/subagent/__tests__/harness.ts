import initSubagent from "../index";

export function createSubagentHarness() {
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
  initSubagent(pi as any);
  return { tools, handlers };
}
