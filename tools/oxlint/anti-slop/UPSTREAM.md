# Anti-slop provenance

This file identifies the source used for future vendor updates. Anti-slop has no supported package and asks consumers to vendor the plugin.

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`.

The complete upstream install asset is copied into this directory. Use the pinned [rule reference](https://github.com/dmmulroy/anti-slop/tree/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b#rules) for behavior and examples.

## Local changes

- Apply the readable-spacing rule to the vendored source.
- Consolidate repeated ESTree traversal, literal checks, and Reflect rule construction.
- Inline the negated semicolon predicate instead of exporting it.

Keep the exact source commit above as the merge base. For an update, stage the new complete install asset and merge its changes with the local Git diff. Preserve `LICENSE` and the nested ESLint Stylistic notice.
