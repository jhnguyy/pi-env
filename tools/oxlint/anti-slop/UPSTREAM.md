# Vendored anti-slop Oxlint plugins

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`.

Use the upstream [rule reference](https://github.com/dmmulroy/anti-slop/tree/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b#rules) for rule behavior and examples.

## Local selection

This directory copies only the rules enabled in [`.oxlintrc.json`](../../../.oxlintrc.json) and their shared modules. The local `index.ts` files expose that selection. This selective copy is an intentional deviation from the upstream full-plugin installer so each rollout phase adds only the source it enforces.

The source is MIT-licensed. Keep `LICENSE` with redistributed copies.

## Updates

Stage an explicit upstream revision outside this directory. Compare and update the selected rule files, their transitive local imports, and the entry points. When a rollout phase enables another rule, copy that rule and only its required local modules. Record the new source revision and any local changes here.
