For files with LSP support, prefer LSP tooling for exploration and navigation over `read` or `bash`.

`ptc` keeps intermediate results out of context; `bash` streams everything back. Use `ptc` when making 2+ tool calls to gather information — multi-file reads, grep → read chains, explore-before-edit. Use `bash` for single commands.

Never read secrets files (`.env`, credentials, keys) directly into context. Pipe values where needed via `bash`/`ptc` without surfacing them.

Never reference external repositories in commits, PRs, or issues (cross-repo links, mentions, closing keywords) without explicit approval. This includes linking issues, commits, or branches across repo boundaries.
