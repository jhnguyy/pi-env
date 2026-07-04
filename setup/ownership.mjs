export function setupMode(env = process.env) {
  if (env.PI_ENV_SETUP_MODE) return env.PI_ENV_SETUP_MODE;
  return env.PI_ENV_CONFIG_MANAGED_BY_NIX === '1' ? 'nix-managed' : 'portable';
}

export function isNixManaged(env = process.env) {
  return setupMode(env) === 'nix-managed' || env.PI_ENV_CONFIG_MANAGED_BY_NIX === '1';
}

export function isCliManagedExternally(env = process.env) {
  return env.PI_ENV_CLI_MANAGED_BY_NIX === '1';
}

export function shouldSkipPathProfile(env = process.env) {
  return isNixManaged(env) || env.PI_ENV_SKIP_PATH_PROFILE === '1';
}
