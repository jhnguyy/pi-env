# Setup tests

Setup tests exercise shell entrypoints and Node setup modules with temporary homes, repos, and PATHs.

## Shared helpers

Source `helpers.sh` instead of redefining common glue:

- `ROOT` — repository root derived from the calling test file.
- `fail` — consistent failure output.
- `node_bin` / `run_node` — Node resolution that follows repo setup rules.
- `assert_eq`, `assert_file_contains`, `assert_file_count` — common assertions.
- `with_temp_dir` — temporary workspace allocation.
- `make_executable` — small fake command creation.

Keep behavior-heavy setup code in `setup/*.mjs` or `setup/*.sh`; tests should assemble fixtures and assert outcomes rather than reimplementing setup logic.
