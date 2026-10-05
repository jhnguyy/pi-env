# Kubernetes agent architecture follow-up

Status: proposed infrastructure follow-up. This consolidation does not deploy an image, activate either agent, or change builder/cache trust.

## Current complexity

The audited agent combines an immutable Nix toolchain with a mutable checkout, dependency hydration, generated user wrappers, an image wrapper, and a persistent personal Nix store. These layers create several possible owners for the executable, startup ordering, and upgrade state.

Pi-env now composes upstream Pi and supplies one repository hydration operation. Infrastructure can use these owners instead of rebuilding another Pi distribution or repeating setup work.

## Preferred direction

1. Build a versioned immutable agent artifact from the locked toolchain, pi-env package resources, and required local adapters. Include ready-to-load extension bundles. Use the same artifact for normal startup and rollback.
2. Keep one stable launch adapter for session-manager integration and container process handling. Avoid chains of generated image and user wrappers that resolve different Pi or Node installations.
3. Persist personal settings, authentication, sessions, model endpoints, MCP configuration, and keybindings separately from the executable and package artifacts. Use native Pi resource selection and explicit reset.
4. Keep mutable development checkouts optional. Hydrate a changed checkout once through the shared operation. Do not make dependency installation or rebuilding the immutable artifact part of every normal startup.
5. Use a locally accessible Nix store for executable paths. Serve built closures from a trusted binary cache. Add remote builders only for cache misses and only through infrastructure-owned trust policy.
6. Retain a writable personal Nix store or profile only when optional user packages need it. Do not require it merely to run the immutable workbench.

An immutable extension package must still use `package.json#pi.extensions` as its active-resource authority. Package production must preserve the existing workspace and artifact checks. Do not introduce an image-specific resource registry.

## Validation before adoption

Compare the proposed artifact with the existing image before changing deployment:

- Fresh startup works without hidden state from a previous pod.
- Offline startup works when the immutable closure and required local resources are present.
- Personalization survives replacement, rescheduling, and rollback.
- Missing or damaged user state produces a clear recovery path, not a second runtime installation.
- Reset remains explicit; the homelab adapter restores its integration afterward.
- Session selection and process signals work through the single launch adapter.
- Kubernetes and the NixOS LXC consume the same Pi release and compatibility requirements.
- Image revision, package revision, and rollout/rollback evidence identify the same artifact.

Infrastructure owns storage layout, builders, cache trust, image creation, and activation. Deliver this follow-up separately from the portable pi-env contribution.
