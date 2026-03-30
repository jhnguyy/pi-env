## ptc vs bash

`ptc` keeps intermediate results out of context. `bash` streams everything back. Use `ptc` for multi-step work; `bash` for single commands.

## Security

Never read secrets files (`.env`, credentials, keys) directly into context. Use `bash`/`ptc` to pipe values where they're needed without surfacing them.
