# Pi 1.5.0 omits schema from its source-built workspace packages. Keep this
# workaround evaluation-only so importing the package never requires a build.
{ pkgs, source, node }:
let
  expression = builtins.readFile (source + "/nix/package.nix");
  replacements = [
    {
      from = "      pack_package packages/telemetry telemetry";
      to = "      pack_package packages/schema schema\n      pack_package packages/telemetry telemetry";
    }
    {
      from = "      \"node_modules/@earendil-works/pi-telemetry\" = workspacePackages + \"/telemetry.tgz\";";
      to = "      \"node_modules/@earendil-works/pi-schema\" = workspacePackages + \"/schema.tgz\";\n      \"node_modules/@earendil-works/pi-telemetry\" = workspacePackages + \"/telemetry.tgz\";";
    }
    {
      from = "./model-catalog.json";
      to = ''(source + "/nix/model-catalog.json")'';
    }
  ];
  matches =
    builtins.hashString "sha256" expression
    == "464aae73421c3bd241088e2eceb3421098f743027b0258e58e68edc07c06a74e"
    && builtins.all (replacement: builtins.length (pkgs.lib.splitString replacement.from expression) == 2) replacements;
  patched =
    if matches then
      builtins.replaceStrings (map (replacement: replacement.from) replacements)
        (map (replacement: replacement.to) replacements) expression
    else
      throw "Pi source packaging changed: remove or review the Pi 1.5.0 schema workaround in nix/pi-package.nix (expression hash or unique anchors differ)";
in
pkgs.callPackage (builtins.toFile "pi-package-schema.nix" patched) {
  inherit source;
  nodejs_22 = node;
}
