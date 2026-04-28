#!/usr/bin/env bash
set -euo pipefail

# Normalize terminal-render artifacts seen in some Ghostty/SSH/tmux paths
# where newline-like boundaries are rendered/pasted as key-sequence fragments.
#
# Usage:
#   pbpaste | scripts/normalize-terminal-paste.sh | pbcopy
#   xclip -o -selection clipboard | scripts/normalize-terminal-paste.sh
#   cat raw.txt | scripts/normalize-terminal-paste.sh > clean.txt

# Prefer perl for robust byte handling; fall back to sed if perl isn't present.
if command -v perl >/dev/null 2>&1; then
  perl -pe '
    s/\x1b\[27;5;106~/\n/g;   # ESC-prefixed xterm Ctrl+J sequence
    s/\x1b\[106;5u/\n/g;      # ESC-prefixed CSI-u Ctrl+J sequence
    s/\[27;5;106~/\n/g;        # pasted/displayed literal tail (ESC dropped)
    s/\[106;5u/\n/g;           # pasted/displayed literal tail (ESC dropped)
  '
else
  sed -E \
    -e $'s/\x1b\[27;5;106~/\
/g' \
    -e $'s/\x1b\[106;5u/\
/g' \
    -e 's/\[27;5;106~/\
/g' \
    -e 's/\[106;5u/\
/g'
fi
