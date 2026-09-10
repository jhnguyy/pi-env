# Vendored anti-slop Oxlint plugins

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`.

The installation copied `skills/install-anti-slop/assets/anti-slop/` from that revision into this directory. The copied files provide these plugin entry points:

- `index.ts` for generic TypeScript and JavaScript policy
- `effect/index.ts` for Effect-specific policy

The source is MIT-licensed. Keep this directory's `LICENSE` with redistributed copies. The readable-spacing rule also contains adapted ESLint Stylistic source. Its separate license and provenance are under `vendor/eslint-stylistic/`.

## Local policy

The plugin source has no local modifications at this revision. The repository owns the rule policy and can change the vendored implementation when project requirements differ.

[`.oxlintrc.json`](../../../.oxlintrc.json) is the source of truth for enabled rules. The initial adoption enables rules with a clean baseline. Later phases can migrate related findings and enable more rules at `error`.

## Updates

Fetch an explicit upstream revision. Stage its install assets outside this directory. Compare the staged source with this revision, then port reviewed changes while preserving local policy and nested notices. Update this file with the new source commit and intentional deviations.
