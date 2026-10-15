import { expect, it } from "vitest";
import { Type } from "typebox";
import { toPiTool, type ToolContract } from "../_shared/tool-contract";

// Isolated adapter check: the same domain contract receives each native invocation's
// cwd, signal and progress callback. Native execution is covered by SDK integration.
it("forwards per-invocation native context and compact progress", async () => {
  const seen: Array<{cwd:string; signal?:AbortSignal}> = [];
  const updates: unknown[] = [];
  const contract: ToolContract<{value:string}, {cwd:string}> = {
    name:"sample", label:"Sample", description:"Sample native contract",
    parameters:Type.Object({value:Type.String()}),
    async execute(params, context) {
      seen.push({cwd:context.cwd,signal:context.signal});
      context.progress?.(context.cwd);
      return {content:[{type:"text",text:params.value}],details:{cwd:context.cwd}};
    },
  };
  const tool = toPiTool(contract);
  const signal = new AbortController().signal;
  await tool.execute("one",{value:"a"},signal,(update)=>updates.push(update),{cwd:"/one"} as any);
  await tool.execute("two",{value:"b"},undefined,undefined,{cwd:"/two"} as any);
  expect(seen).toEqual([{cwd:"/one",signal},{cwd:"/two",signal:undefined}]);
  expect(updates).toEqual([{content:[{type:"text",text:"/one"}],details:{phase:"/one"}}]);
});
