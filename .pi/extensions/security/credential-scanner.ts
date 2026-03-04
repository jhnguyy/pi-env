/**
 * CredentialScanner — sensitive file detection.
 *
 * Used by the tool_result hook to fully redact reads of known
 * sensitive files before the content reaches the LLM.
 *
 * Text-scanning (hasCredentials / redact) was removed: pattern-matching
 * secrets in arbitrary output has no semantic grounding, produces false
 * positives and false negatives, and the LLM already processed the value
 * during execution. The right protection is at the input side — block
 * reading the file in the first place.
 */

/** File names that should have their content redacted entirely on read */
export const SENSITIVE_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.staging",
  "auth.json",
  "secrets.json",
  "credentials.json",
  "service-account.json",
  ".npmrc",
  ".netrc",
  "terraform.tfstate",
]);

export class CredentialScanner {
  /** Check if a filename is a known sensitive file (should be fully redacted) */
  isSensitiveFileName(path: string): boolean {
    const filename = path.split("/").pop() ?? "";
    return SENSITIVE_FILE_NAMES.has(filename);
  }
}
