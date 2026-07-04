export const SetupMode = Object.freeze({
  Portable: 'portable',
  NixManaged: 'nix-managed',
});

export const Ownership = Object.freeze({
  Setup: 'setup',
  External: 'external',
});

function flag(env, name) {
  return env[name] === '1';
}

export function deriveSetupPolicy(env = process.env) {
  const mode = env.PI_ENV_SETUP_MODE
    || (flag(env, 'PI_ENV_CONFIG_MANAGED_BY_NIX') ? SetupMode.NixManaged : SetupMode.Portable);
  const nixManaged = mode === SetupMode.NixManaged || flag(env, 'PI_ENV_CONFIG_MANAGED_BY_NIX');
  const terminalDisabled = flag(env, 'PI_ENV_SKIP_TERMINAL');
  const terminalManagedExternally = nixManaged || terminalDisabled;
  const cliManagedExternally = flag(env, 'PI_ENV_CLI_MANAGED_BY_NIX');
  const pathManagedExternally = nixManaged || flag(env, 'PI_ENV_SKIP_PATH_PROFILE');
  const repoHooksDisabled = flag(env, 'PI_ENV_SKIP_REPO_HOOKS');
  const tmuxManagedExternally = terminalManagedExternally || flag(env, 'PI_ENV_SKIP_TMUX');
  const ghosttyManagedExternally = terminalManagedExternally || flag(env, 'PI_ENV_SKIP_GHOSTTY');

  return Object.freeze({
    mode,
    nixManaged,
    pi: Object.freeze({
      settings: Ownership.Setup,
      agentFiles: Ownership.Setup,
    }),
    cli: Object.freeze({
      owner: cliManagedExternally ? Ownership.External : Ownership.Setup,
      writeWrapper: !cliManagedExternally,
    }),
    path: Object.freeze({
      owner: pathManagedExternally ? Ownership.External : Ownership.Setup,
      updateShellProfiles: !pathManagedExternally,
    }),
    terminal: Object.freeze({
      owner: terminalManagedExternally ? Ownership.External : Ownership.Setup,
      enabled: !terminalDisabled,
      tmux: Object.freeze({
        owner: tmuxManagedExternally ? Ownership.External : Ownership.Setup,
        configure: !tmuxManagedExternally,
      }),
      ghostty: Object.freeze({
        owner: ghosttyManagedExternally ? Ownership.External : Ownership.Setup,
        configure: !ghosttyManagedExternally,
      }),
    }),
    repoTools: Object.freeze({
      owner: repoHooksDisabled ? Ownership.External : Ownership.Setup,
      installHooks: !repoHooksDisabled,
    }),
  });
}

export function setupMode(env = process.env) {
  return deriveSetupPolicy(env).mode;
}

export function isNixManaged(env = process.env) {
  return deriveSetupPolicy(env).nixManaged;
}

export function isCliManagedExternally(env = process.env) {
  return deriveSetupPolicy(env).cli.owner === Ownership.External;
}

export function shouldSkipPathProfile(env = process.env) {
  return deriveSetupPolicy(env).path.owner === Ownership.External;
}
