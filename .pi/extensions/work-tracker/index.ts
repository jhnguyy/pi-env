import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiEvent, registerAgentTools, ToolCapability } from "../_shared/agent-tools";
import { registerCommands } from "./commands";
import { loadConfig } from "./context";
import { registerHooks } from "./hooks";
import { TodoStore } from "./store";
import { TODO_PARAMETERS, executeTodo, prepareTodoArguments, type TodoParams } from "./todo-tool";

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const store = new TodoStore();

  registerCommands(pi);

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Manage your session task list. Use to track multi-step plans, mark progress, " +
      "and keep yourself organized across turns. The list is visible in context every turn.",
    parameters: TODO_PARAMETERS,
    // Sessions created before #93 stored text as a bare string; normalize them on resume.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepareArguments(args: unknown): any {
      return prepareTodoArguments(args);
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return executeTodo(store, params as TodoParams, ctx, pi);
    },
  });

  registerHooks(pi, config, store);

  pi.on(PiEvent.SessionStart, () => {
    const todoAgentTool: AgentTool<any, any> = {
      name: "todo",
      label: "Todo",
      description: "Manage your session task list. Actions: add, done, rm, list, clear.",
      parameters: TODO_PARAMETERS,
      execute: async (_id, params) => executeTodo(store, params as TodoParams),
    };
    registerAgentTools(pi, { tool: todoAgentTool, capabilities: [ToolCapability.Write] });
  });
}
