# pi-env prerequisites

Nix supplies the workbench through [the upstream packaging boundary](nix.md). Without Nix, portable setup requires Git and Nub; Nub selects the Node runtime from `package.json#engines.node`.

Setup performs one frozen dependency installation. The shared hydration operation patches the Effect language service, builds extensions, and restarts the LSP daemon after artifacts are ready. Setup does not delete dependencies or retry a failed installation.

Local Nix needs flakes and a usable store. Externally managed setup consumes supplied tools without invoking Nix. Neither path changes system packages or remote-builder configuration through portable setup.

Personal defaults and explicit reset behavior are described in [setup](setup.md). Resource enablement belongs to Pi's stock package manager.
