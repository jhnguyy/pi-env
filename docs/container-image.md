# Container image

The image packages the portable workbench, not a configured agent identity. Credentials, personal settings, sessions, and deployment state remain external. Downstream images own any additional transport tools and their security-update policy.

The [Nix image definitions](../nix/builder-image.nix) supply builder and runtime bases from the same locked tools. The [Dockerfile](../Dockerfile) installs dependencies and hydrates components once in its verification target. Tests run against that baked image with `verify:full --prebuilt`; final assembly consumes it without another installation or build. The non-root runtime omits build-only tooling and receives the same application bundles.

The [image workflow](../.github/workflows/image.yml) owns qualification and retained evidence. It checks bundle identity and exercises the built components again in the final runtime. Setup fixtures remain part of qualification, not a clean Nub/Nix installer test. Building an image alone does not establish that its tests passed.

Registry publication and new binary-cache exports are blocked while Nix closure notices/corresponding source and OS vulnerability-scan coverage remain unqualified. The closure inventory is not a compliance bundle; a green Trivy result does not establish Nix OS coverage. See [licensing](licensing.md).

[Nub packaging](../nix/nub.nix) uses checksum-pinned official binaries without compiling Rust. Those binaries lack Rust dependency metadata, so the package also retains checksum-pinned workspace and native-addon lockfiles from the same upstream release for scanning. These are conservative source inventories, including dependencies that may not be compiled into the binary, not binary dependency attestations. [`.trivyignore.yaml`](../.trivyignore.yaml) owns the accepted findings, version-specific paths, and expiry dates; those exceptions do not establish that a vulnerability is fixed.

For a local Docker build, first load both locked bases, then build the verification target before final assembly:

```bash
for target in builder-image runtime-image; do
  stream="$(nix build ".#$target" --no-link --print-out-paths)"
  "$stream" | docker load
done
docker buildx bake verification
docker run --rm --init pi-env:verification nub run verify:full --prebuilt
docker buildx bake image
```

Downstream images must not assume Debian tools or `apt` are available.
