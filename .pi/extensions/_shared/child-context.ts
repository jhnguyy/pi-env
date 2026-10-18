import { AsyncLocalStorage } from "node:async_hooks";

export interface ChildContext {
  cwd: string;
  agentDir: string;
  id?: string;
}

// Extensions are bundled independently; all bundles must share the creation scope.
const key = Symbol.for("pi-env.child-context");
const shared = globalThis as typeof globalThis & {
  [key]?: AsyncLocalStorage<ChildContext>;
};
const storage = shared[key] ??= new AsyncLocalStorage<ChildContext>();

export function getChildContext(): ChildContext | undefined {
  return storage.getStore();
}

export function withChildContext<T>(context: ChildContext, operation: () => T): T {
  return storage.run(context, operation);
}
