import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands";
import { loadConfig } from "./context";
import { registerHooks } from "./hooks";
import { TodoStore } from "./store";
import * as TodoTool from "./todo-tool";

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
    parameters: TodoTool.TODO_PARAMETERS,
    // Sessions created before #93 stored text as a bare string; normalize them on resume.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepareArguments(args: unknown): any {
      return TodoTool.prepareTodoArguments(args);
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return TodoTool.executeTodo(store, params, ctx, pi);
    },
  });

  registerHooks(pi, config, store);
}
