export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_PACKAGE_PREFIX = "@earendil-works/pi-";
export const DEFAULT_REPO = "/mnt/tank/code/pi-env";

export const PI_UPDATE_DOC_PATHS = [
  "package/CHANGELOG.md",
  "package/README.md",
  "package/docs/extensions.md",
  "package/docs/sdk.md",
  "package/docs/usage.md",
  "package/docs/settings.md",
] as const;

export interface PiUpdateOptions {
  version: string;
  repo?: string;
  worktreeDir?: string;
}

export interface PiUpdatePrep {
  version: string;
  branch: string;
  worktree: string;
  report: string;
  changelog: string;
  installCommand: string;
}
