/**
 * @module _shared/errors
 * @purpose Typed extension errors with error codes + uniform catch-block formatting.
 *
 * @example Defining an error
 *   export type MyErrorCode = "THING_FAILED" | "OTHER_FAILED";
 *   export class MyError extends BaseExtensionError<MyErrorCode> {}
 *
 * @example Formatting in a catch block
 *   catch (e) { return err(formatError(e, "myext")); }
 *   // BaseExtensionError → "myext error [THING_FAILED]: thing broke"
 *   // plain Error         → "thing broke"
 *   // unknown             → "unexpected error: ..."
 */

export class BaseExtensionError<Code extends string> extends Error {
  constructor(
    message: string,
    public code: Code,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * Uniform error-to-string for tool execute catch blocks.
 *
 * - BaseExtensionError → includes `[code]` and optional label prefix
 * - Error              → `.message` only
 * - unknown            → `"unexpected error: ${e}"`
 */
export function formatError(e: unknown, label?: string): string {
  if (e instanceof BaseExtensionError) {
    const prefix = label ? `${label} error ` : "";
    return `${prefix}[${e.code}]: ${e.message}`;
  }
  if (e instanceof Error) return e.message;
  return `unexpected error: ${e}`;
}
