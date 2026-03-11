# pi as a Bun Compiled Binary

Why and how pi is installed as a Bun binary rather than run directly via `node`.

## Why Bun Binary Instead of npm Global

pi's default `npm install -g` install runs as a Node script. Extensions are
loaded by jiti using filesystem path aliases. In practice this causes a failure
in extensions that mix `require()` calls and top-level `await`:

> Cannot determine intended module format because both require() and top-level
> await are present.

When pi is compiled with `bun build --compile`, jiti uses pre-bundled virtual
modules with `tryNative: false` — it handles all imports itself instead of
delegating to Node's native loader, which is where the format-detection error
originates. The compiled binary avoids this class of CJS/ESM conflict entirely.

## Asset Layout

pi's official release tarballs ship a self-contained directory: the binary sits
alongside its assets. When `isBunBinary=true`, pi resolves `theme/` and
`export-html/` via `dirname(process.execPath)`, and `package.json` via
`getPackageDir()` (which also defaults to `dirname(process.execPath)`).

`setup/install-bun-pi.sh` reproduces this layout by symlinking the assets from
node\_modules into the binary's directory:

```
~/.local/bin/
├── pi              ← compiled Bun binary
├── package.json    → <repo>/node_modules/@mariozechner/.../package.json
├── theme/          → <repo>/node_modules/@mariozechner/.../dist/.../theme/
└── export-html/    → <repo>/node_modules/@mariozechner/.../dist/.../export-html/
```

When pi is updated via `bun install`, the symlinks continue to point at the
correct (updated) assets — only the binary itself needs recompilation.

### `PI_PACKAGE_DIR` Override

The `PI_PACKAGE_DIR` env var overrides `getPackageDir()`, which controls where
pi looks for `package.json`, `README.md`, `docs/`, `examples/`, and
`CHANGELOG.md`. It does **not** affect `theme/` or `export-html/` — those
always resolve next to the binary. This is useful in environments like Nix/Guix
where the binary lives in a read-only store path separate from the package
metadata.

## The ZFS `bun --compile` Bug

`bun build --compile` silently writes a zero-byte file (correct size, corrupt
content) when `--outfile` is on a ZFS filesystem. The binary appears to compile
successfully but fails at runtime with `Exec format error`.

Diagnose with:

```bash
od -A x -t x1z ~/.local/bin/pi | head -2
# Corrupt: 00 00 00 00 ...
# Valid:   7f 45 4c 46 ...  (ELF magic bytes)
```

**Workaround:** compile to `/tmp` first, then copy. `install-bun-pi.sh` does
this automatically.

## Package Source

`install-bun-pi.sh` (called by `setup.sh`) uses the `@mariozechner/pi-coding-agent`
package from the repo's own `node_modules/`, installed by `bun install` from the
version pinned in `bun.lock`. No global npm install is required — the repo lockfile
is the single source of truth for the pi version.

To update pi: bump the version in `package.json`, run `bun install` (updates the
lockfile), then re-run `./setup.sh` to recompile the binary.
