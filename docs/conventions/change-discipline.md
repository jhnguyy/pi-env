# Change discipline

Use this sequence for human and agent changes:

1. State the material assumptions, success criteria, and required validation.
2. Inspect existing owners, their callers, nearby tests, and conventions before selecting an implementation.
3. Choose the minimum sufficient solution. Keep the change surgical and preserve unrelated behavior.
4. Run focused checks while you work. Use failures to revise the implementation or the assumptions.
5. Run the required integration portfolio before review or integration.

Record an assumption when it can change the solution, risk, or result. Do not add speculative abstractions or unrelated cleanup. If the minimum solution cannot meet the success criteria, explain the constraint before expanding the scope.

## Prior-art and reuse gate

Before adding a responsibility or changing a module boundary:

1. Name the capability and the callers that need it.
2. Find existing owners in the affected area, shared modules, and relevant installed dependencies.
3. Compare inputs, outputs, authority, lifecycle, and failure behavior. Similar names or shapes do not establish equivalent contracts.
4. Choose direct reuse, extension of an existing owner, or a separate owner. Explain the contract difference when keeping separate owners.

Record the considered owners, affected callers, and reuse decision under the pull request's decisions and risks. Keep the record proportional to the change. A few lines can be sufficient.

Use AST inspection and reference searches to find candidates. Include unchanged candidate owners in the comparison scope. Clean duplicate or complexity reports do not establish reuse.

Use the source-owned commands and policies for validation. The [testing convention](testing.md) defines test evidence and verification portfolios.
