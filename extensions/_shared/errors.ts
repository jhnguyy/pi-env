export class BaseExtensionError<Code extends string> extends Error {
  constructor(
    message: string,
    public code: Code,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export function formatError(e: unknown, label?: string): string {
  if (e instanceof BaseExtensionError) {
    const prefix = label ? `${label} error ` : "";
    return `${prefix}[${e.code}]: ${e.message}`;
  }
  if (e instanceof Error) return e.message;
  return `unexpected error: ${e}`;
}
