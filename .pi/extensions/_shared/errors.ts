/**
 * errors.ts — shared base class for typed extension errors.
 *
 * Each extension defines its own Code union type and extends this class.
 * Eliminates the boilerplate `extends Error` pattern repeated in
 * agent-bus, orch, and tmux.
 *
 * Usage:
 *   export type MyErrorCode = "THING_FAILED" | "OTHER_FAILED";
 *   export class MyError extends BaseExtensionError<MyErrorCode> {}
 */

export class BaseExtensionError<Code extends string> extends Error {
  constructor(
    message: string,
    public code: Code
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}
