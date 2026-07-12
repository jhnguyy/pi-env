export class SetupEnvError extends Error {
  constructor(name) {
    super(`${name} is required`);
    this.name = "SetupEnvError";
    this._tag = "SetupEnvError";
    this.envName = name;
    this.exitCode = 1;
  }
}

export class SetupCommandStartError extends Error {
  constructor(command, args, cause) {
    super(`${command} ${args.join(" ")} failed to start: ${cause?.message ?? String(cause)}`);
    this.name = "SetupCommandStartError";
    this._tag = "SetupCommandStartError";
    this.command = command;
    this.args = args;
    this.cause = cause;
    this.exitCode = 1;
  }
}

export class SetupCommandExitError extends Error {
  constructor(command, args, status, stderr) {
    super(`${command} ${args.join(" ")} exited with ${status}: ${stderr ?? ""}`.trim());
    this.name = "SetupCommandExitError";
    this._tag = "SetupCommandExitError";
    this.command = command;
    this.args = args;
    this.status = status;
    this.stderr = stderr;
    this.exitCode = status ?? 1;
  }
}

export class SetupFileError extends Error {
  constructor(operation, path, cause) {
    super(`${operation} failed for ${path}: ${cause?.message ?? String(cause)}`);
    this.name = "SetupFileError";
    this._tag = "SetupFileError";
    this.operation = operation;
    this.path = path;
    this.cause = cause;
    this.exitCode = 1;
  }
}

export class SetupUsageError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "SetupUsageError";
    this._tag = "SetupUsageError";
    this.exitCode = exitCode;
  }
}

export function isSetupError(error) {
  return typeof error?._tag === "string" && error._tag.startsWith("Setup");
}

export function renderSetupError(error) {
  return error?.message ?? String(error);
}

export function setupErrorExitCode(error) {
  const exitCode = Number(error?.exitCode);
  return Number.isInteger(exitCode) && exitCode >= 0 ? exitCode : 1;
}
