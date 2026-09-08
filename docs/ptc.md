# Programmatic Tool Calling

Programmatic Tool Calling (PTC) runs a TypeScript or JavaScript batch script. Nested tool results stay outside model context until the script selects or combines them.

## Runtime contract

Use `action="inspect"` when tool availability is uncertain or changes at runtime. Inspect reports callable tools, active direct-only tools, blocked tools, and copyable TypeScript declarations. It does not start a child process.

Use `action="run"` to execute `code`. The action defaults to `run`, so existing `{ code }` calls remain valid. Each run uses one tool snapshot.

The `tools` namespace is the canonical API. Each nested tool returns plain text as `Promise<string>`:

```ts
return await tools.bash({ command: "git status --short" });
```

Bracket access preserves an exact tool name such as `tools["dev-tools"]`. Global underscore aliases such as `dev_tools` remain compatible. Their removal is not scheduled.

## Aggregation

Use `console.log()` for selected output. Use `settle` when one independent call can fail without stopping the batch:

```ts
const output: string[] = [];
for (const path of ["README.md", "missing.md"]) {
  const result = await settle(tools.read({ path }));
  if (result.ok) output.push(`${path}: ${result.value.split("\n")[0]}`);
  else output.push(`${path}: ${result.error.message}`);
}
return output.join("\n");
```

Normal wrappers remain fail-fast. `settle` returns either `{ ok: true, value }` or `{ ok: false, error }`. The error contains a class, a message, and the tool name when known.

PTC returns only nested text content to the script. It does not expose direct-tool `details` or non-text content. Blocked and active direct-only tools must run directly.
