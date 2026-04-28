# pi-env

Personal [pi](https://github.com/badlogic/pi-mono) environment — extensions, skills, themes, and agent context as a dotfiles repo. Shared as a reference; setups are inherently personalized.

## Setup

Prerequisites: `git` and [bun](https://bun.sh) ≥ 1.3.

```bash
git clone <your-fork> ~/pi-env
cd ~/pi-env
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.profile to persist
./setup.sh
```

`setup.sh` is self-documenting — its header lists everything it does and what it leaves alone.

## Further reading

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — branch conventions, building extensions, worktree workflow
- **[docs/pi-capability-map.md](docs/pi-capability-map.md)** — auto-generated index of pi's built-in capabilities
- **[pi docs](https://github.com/badlogic/pi-mono)** — upstream reference for the extensions API, skills spec, and settings
