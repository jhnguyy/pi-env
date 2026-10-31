import { connect } from "../client.js";
import type { Cancel, Input, ResultRequest, Submit } from "../contract.js";

export type Command =
  | { id: number; action: "submit"; input: Submit }
  | { id: number; action: "input"; input: Input }
  | { id: number; action: "cancel"; input: Cancel }
  | { id: number; action: "result"; input: ResultRequest }
  | { id: number; action: "resultFull"; input: { operationId: string } }
  | { id: number; action: "inspect" | "reopen"; input: { childId: string } }
  | { id: number; action: "closeRun"; input: { runId: string } };

const client = await connect(process.argv[2], process.argv[4] ?? "fixture-parent");
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
        case "result": result = await client.view.result(command.input); break;
        case "resultFull": result = await client.view.resultFull(command.input); break;
        case "reopen": result = await client.view.reopen(command.input); break;
        case "closeRun": result = await client.view.closeRun(command.input); break;
        case "inspect": {
          const inspection = await client.inspect(command.input.childId);
          try { result = inspection.snapshot.value; } finally { inspection.release(); }
          break;
        }
      }
      process.send?.({ id: command.id, result });
    } catch (error) {
      process.send?.({ id: command.id, error: String(error) });
    }
  })();
});
