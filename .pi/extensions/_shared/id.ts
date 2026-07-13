import { randomBytes } from "node:crypto";

export function generateId(bytes: number = 3): string {
  return randomBytes(bytes).toString("hex");
}
