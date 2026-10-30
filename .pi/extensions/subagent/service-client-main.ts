import { Type } from "typebox";
import { Check } from "typebox/value";
import { connect } from "../../../src/subagent-service/client.js";
import { CancelSchema, InputSchema, SubmitSchema } from "../../../src/subagent-service/contract.js";

const Command = Type.Union([
  Type.Object({ action: Type.Literal("submit"), request: SubmitSchema }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("input"), request: InputSchema }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("cancel"), request: CancelSchema }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("status") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("inspect"), childId: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
]);
const [directory] = process.argv.slice(2);
if (!directory) throw new Error("Usage: subagent:client <private-state-directory> < request.json");
const chunks: Buffer[] = [];
let length = 0;
for await (const chunk of process.stdin) {
  const bytes = Buffer.from(chunk);
  length += bytes.length;
  if (length > 65_536) throw new Error("request_too_large");
  chunks.push(bytes);
}
const command: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (!Check(Command, command)) throw new Error("invalid_command");
const client = await connect(directory);
try {
  let result: unknown;
  switch (command.action) {
    case "submit": result = await client.view.submit(command.request); break;
    case "input": result = await client.view.input(command.request); break;
    case "cancel": await client.view.cancel(command.request); result = { cancellationRequested: true }; break;
    case "inspect": result = await client.view.inspect({ childId: command.childId }); break;
    case "status": result = client.view.snapshot.value; break;
  }
  process.stdout.write(JSON.stringify(result) + "\n");
} finally { await client.close(); }
