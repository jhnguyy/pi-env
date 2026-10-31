import type { SubagentServiceConnection } from "../service-host";

/** No native dispatch: journal and startup-failure tests exercise only this external client port. */
export function serviceClientFixture(options: {
  close?: () => Promise<void>;
  closeRun?: SubagentServiceConnection["view"]["closeRun"];
} = {}): SubagentServiceConnection {
  const controller = new AbortController();
  const unused = async () => { throw new Error("This scenario must not dispatch native work"); };
  let closed = false;
  return {
    signal: controller.signal,
    view: {
      snapshot: {
        value: { serviceId: "fixture", epoch: "fixture", bundleId: "0".repeat(64), revision: 0, children: [], operations: [] },
        subscribe: () => () => {},
      },
      submit: unused, input: unused, cancel: unused, result: unused, resultFull: unused, reopen: unused,
      closeRun: options.closeRun ?? unused,
    },
    inspect: unused,
    async close() {
      if (closed) return;
      closed = true;
      controller.abort(new Error("Fixture client disconnected"));
      await options.close?.();
    },
  };
}
