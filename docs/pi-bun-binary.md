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

## Required Assets Next to the Binary

When running as a Bun binary, pi resolves all assets relative to
`dirname(process.execPath)` — the directory containing the binary. The
following must exist adjacent to it:

| File/Dir       | Required for                      |
|----------------|-----------------------------------|
| `package.json` | Startup (version, app name)       |
| `theme/`       | Interactive mode (built-in themes)|
| `export-html/` | `/export` command                 |

`setup/install-bun-pi.sh` symlinks all three from the npm package directory.
When pi is updated via npm, the symlinks continue to point at the correct
assets — only the binary itself needs recompilation.

The `PI_PACKAGE_DIR` env var overrides this lookup. Useful in environments
where you can't control the binary's parent directory.

## The ZFS `bun --compile` Bug

`bun build --compile` silently writes a zero-byte file (correct size, corrupt
content) when `--outfile` is on a ZFS filesystem. The binary appears to compile
successfully but fails at runtime with `Exec format error`.

Diagnose with:

```bash
od -A x -t x1z ~/.pi/bin/pi | head -2
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

## The `~/.pi/bin/` Layout

After running `./setup.sh` (or `setup/install-bun-pi.sh` directly):

```
~/.pi/bin/
├── pi              ← compiled Bun binary
├── package.json    → <repo>/node_modules/@mariozechner/.../package.json
├── theme/          → <repo>/node_modules/@mariozechner/.../dist/.../theme/
└── export-html/    → <repo>/node_modules/@mariozechner/.../dist/.../export-html/
```
