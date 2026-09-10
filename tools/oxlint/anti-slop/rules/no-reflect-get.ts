import { createNoReflectRule } from "../shared/reflect-method.ts";

/** Ban Reflect.get, which bypasses ordinary property access and useful type evidence. */
export const noReflectGetRule = createNoReflectRule({
  methodName: "get",
  description:
    "Disallow Reflect.get; use typed property access or parse dynamic input into a domain type.",
  message:
    "Replace `Reflect.get` with typed property access. Parse dynamic input into a named domain type before reading it.",
  messageId: "reflectGet",
});
