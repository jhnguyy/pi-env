import { acquireFileLock } from "../../src/process/file-lock";

export const acquireBindingLock = (socketPath: string) =>
  acquireFileLock(`${socketPath}.pi-bindings.lock`);
