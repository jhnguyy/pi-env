import { connect } from "../client.js";
import type { Cancel, Input, Submit } from "../contract.js";

export type Command =
  | { id: number; action: "submit"; input: Submit }
  | { id: number; action: "input"; input: Input }
  | { id: number; action: "cancel"; input: Cancel }
  | { id: number; action: "inspect"; input: { childId: string } };

const client = await connect(process.argv[2]);
client.view.snapshot.subscribe(() => process.send?.({ snapshot: client.view.snapshot.value }));
process.send?.({ ready: true, snapshot: client.view.snapshot.value });
process.on("message", (command: Command | "shutdown") => {
  if (command === "shutdown") {
    void client.close().then(() => process.disconnect?.());
    return;
  }
  void (async () => {
    try {
      let result: unknown;
      switch (command.action) {
        case "submit": result = await client.view.submit(command.input); break;
        case "input": result = await client.view.input(command.input); break;
        case "cancel": result = await client.view.cancel(command.input); break;
        case "inspect": result = await client.view.inspect(command.input); break;
      }
      process.send?.({ id: command.id, result });
    } catch (error) {
      process.send?.({ id: command.id, error: String(error) });
    }
  })();
});
