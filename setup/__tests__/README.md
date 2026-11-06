# Setup tests

Setup tests exercise shell entrypoints and Node setup modules with temporary homes, repos, and PATHs.

Source `helpers.sh` for shared fixtures and assertions. It creates one temporary root per test process and removes it on exit, so tests need no cleanup of their own. Stubs report calls on stderr; tests capture that output rather than writing call logs.

Keep behavior-heavy setup code in `setup/*.mjs` or `setup/*.sh`. Tests should assemble fixtures and assert outcomes rather than reimplementing setup logic.
