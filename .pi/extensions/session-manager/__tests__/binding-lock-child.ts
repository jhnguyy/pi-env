import { Effect } from "effect";
import { acquireBindingLock } from "../binding-lock.ts";

const socket = process.argv[2];
if (!socket) throw new Error("Binding lock fixture requires a socket path");
await Effect.runPromise(acquireBindingLock(socket));
process.stdout.write("locked");
