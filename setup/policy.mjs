export const SetupMode = Object.freeze({
  Portable: 'portable',
  LocalNix: 'local-nix',
  NixManaged: 'nix-managed',
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

  return Object.freeze({
    mode,
    cli: Object.freeze({
      writeWrapper: !flag(env, 'PI_ENV_CLI_MANAGED_BY_NIX'),
    }),
    path: Object.freeze({
      updateShellProfiles: !nixManaged && !flag(env, 'PI_ENV_SKIP_PATH_PROFILE'),
    }),
    terminal: Object.freeze({
      enabled: !terminalDisabled,
      tmux: Object.freeze({
        configure: !terminalManagedExternally && !flag(env, 'PI_ENV_SKIP_TMUX'),
      }),
      ghostty: Object.freeze({
        configure: !terminalManagedExternally && !flag(env, 'PI_ENV_SKIP_GHOSTTY'),
        // setup/environment.sh detects whether this host needs Ghostty.
        needed: flag(env, 'SHOULD_LINK_GHOSTTY'),
        context: env.CONTEXT_LABEL || 'this context',
      }),
    }),
    repoTools: Object.freeze({
      installHooks: !flag(env, 'PI_ENV_SKIP_REPO_HOOKS'),
    }),
    homeManager: Object.freeze({
      sync: !flag(env, 'PI_ENV_SKIP_HOME_MANAGER'),
      update: flag(env, 'PI_ENV_HOME_MANAGER_SYNC'),
    }),
  });
}
