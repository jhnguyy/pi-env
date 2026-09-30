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

/** Exact file names that should have their content redacted entirely on read */
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

/**
 * Directories whose contents should be redacted entirely on read.
 * Normalized without trailing slash — matched as a prefix against resolved paths.
 */
export const SENSITIVE_DIRECTORIES = [
  ".pi/secrets",
];

export class CredentialScanner {
  /** Check if a file path points to a known sensitive file (should be fully redacted) */
  isSensitiveFileName(path: string): boolean {
    const filename = path.split("/").pop() ?? "";

    // Exact filename match (e.g. ".env", "auth.json")
    if (SENSITIVE_FILE_NAMES.has(filename)) return true;

    // Any file ending in .env (catches "couchdb.env", "infra.env", etc.)
    if (filename.endsWith(".env")) return true;

    // Files inside known sensitive directories
    for (const dir of SENSITIVE_DIRECTORIES) {
      if (path.includes(`/${dir}/`) || path.endsWith(`/${dir}`)) return true;
    }

    return false;
  }
}
