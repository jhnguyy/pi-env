import { spawnSync } from 'node:child_process';

export const RuntimeCommand = Object.freeze({
  Dependencies: 'dependencies',
  PiCli: 'pi-cli',
});

export function mustEnv(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
}

export function fail(message, exitCode = 1) {
  console.error(message);
  process.exit(exitCode);
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: process.env,
    stdio: options.stdio ?? 'inherit',
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}

export function runChecked(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} exited with ${result.status}.`, result.status ?? 1);
  }
  return result;
}

export function commandSucceeds(command, args, options = {}) {
  return run(command, args, { ...options, stdio: 'ignore' }).status === 0;
}
