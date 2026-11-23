# Container image

The image packages the portable workbench, not a configured agent identity. Credentials, personal settings, sessions, and deployment state remain external. Downstream images own any additional transport tools and their security-update policy.

The [image workflow](../.github/workflows/image.yml) owns qualification, publication, and retained evidence. It calls the [Nix builder workflow](../.github/workflows/nix-builder.yml) for source verification with the baked toolchain; setup fixtures run there, not in a clean Nub/Nix provisioning environment. The [Dockerfile](../Dockerfile) still owns the portable runtime image contents; building an image is not a claim that its tests passed. See [licensing](licensing.md) for distribution obligations.
