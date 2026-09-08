# Programmatic Tool Calling

Programmatic Tool Calling (PTC) runs a TypeScript or JavaScript batch script in a child process. Nested tool results stay outside model context until the script selects or combines them.

## Actions

The `ptc` tool supports these actions:

- `inspect` reports the current runtime contract. It does not start a child process.
- `run` executes `code`.

The action defaults to `run` when a call supplies `code`. Existing `{ code }` calls remain valid.

Use `inspect` when tool availability is uncertain. Also use it after dynamic tool activation or before an extension-tool call.

## Tool calls

The `tools` namespace is the canonical scripting API:

```ts
return await tools.read({ path: "README.md" });
```

Use bracket access when you need the exact tool name:

```ts
return await tools["dev-tools"]({ action: "diagnostics", path: "src/index.ts" });
```

Each nested tool returns `Promise<string>`. The string contains the text content from the direct tool result. PTC does not expose direct-tool `details` or non-text content to the script.

Global underscore aliases remain available for compatibility. For example, `dev_tools(...)` calls `tools["dev-tools"](...)`. Their removal is not scheduled.

## Output

Use `return` for one final value:

```ts
return await tools.bash({ command: "git status --short" });
```

Use `console.log()` for multiple selected values or for progress that must remain in the final output:

```ts
for (const path of ["README.md", "CONTRIBUTING.md"]) {
  const text = await tools.read({ path });
  console.log(`${path}: ${text.split("\n")[0]}`);
}
```

PTC preserves selected `console.log()` output in order. It appends a non-null explicit return value after that output.

## Settled calls

Normal tool wrappers fail fast. Use `settle` when one independent item can fail without stopping the batch:

```ts
const output: string[] = [];
for (const path of ["README.md", "missing.md"]) {
  const result = await settle(tools.read({ path }));
  if (result.ok) output.push(`${path}: ${result.value.split("\n")[0]}`);
  else output.push(`${path}: ${result.error.message}`);
}
return output.join("\n");
```

`settle` returns this discriminated result:

```ts
type Settled<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        class:
          | "blocked-tool"
          | "unavailable-tool"
          | "inactive-tool"
          | "unknown-tool"
          | "nested-tool"
          | "user-script";
        message: string;
        tool?: string;
      };
    };
```

## Availability

PTC takes a tool snapshot at the start of each run. A tool activated during one run is available to the next run.

`inspect` separates tools into these groups:

- Callable tools have a PTC dispatcher and are active.
- Active direct-only tools are active but do not have a PTC dispatcher. Call these tools directly.
- Blocked tools must run directly because they start agents, manage long-running work, or recurse into PTC.

The `tools` namespace returns classified errors for blocked, unavailable, and unknown entries. Call `inspect` again when runtime activation or registration state changes.
