# Session identity and display names

Session-manager identifies each session by its session ID. IDs must be unique in the workspace manifest, including the coordinator ID. A live owner retains exclusive ownership of its session binding.

Names are optional, non-unique display labels. Active work sessions can start with the same explicit name, adopt that name, or rename to that name. A name does not select a session. Lookup, release, and restoration use session IDs.

An explicit name must contain non-whitespace text, fit within 128 UTF-8 bytes, and contain no control or format characters. These constraints also apply to names in the manifest.

`/session-status` and workspace restoration summaries show the full session ID beside a name. Tmux window labels retain explicit names, so multiple windows can have the same label. Unnamed windows use the existing `pi-<ID suffix>` label. Session-manager does not use window labels to select a binding.
