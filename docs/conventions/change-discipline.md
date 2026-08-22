# Change discipline

Use this sequence for human and agent changes:

1. State the material assumptions, success criteria, and required validation.
2. Inspect the nearest code, tests, and conventions before selecting an implementation.
3. Choose the minimum sufficient solution. Keep the change surgical and preserve unrelated behavior.
4. Run focused checks while you work. Use failures to revise the implementation or the assumptions.
5. Run the required integration portfolio before review or integration.

Record an assumption when it can change the solution, risk, or result. Do not add speculative abstractions or unrelated cleanup. If the minimum solution cannot meet the success criteria, explain the constraint before expanding the scope.

Use the source-owned commands and policies for validation. The [testing convention](testing.md) defines test evidence and verification portfolios.
