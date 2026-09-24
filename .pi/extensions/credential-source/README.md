# Credential source extension

The credential source extension gives trusted Pi extensions scoped access to named credentials. It does not register a model-facing tool or command.

Consumers use fixed logical names such as `linear.apiKey`. Each entry also names the trusted consumer extensions that can use it. Only global settings can map logical names to password-manager references. A project `.pi/settings.json` file cannot define or override `credentialSource`.

## Global settings

Add `credentialSource` to `~/.pi/agent/settings.json`.

### 1Password CLI

```json
{
  "credentialSource": {
    "entries": {
      "linear.apiKey": {
        "provider": "1password",
        "consumers": ["linear"],
        "reference": "op://Private/Linear/credential"
      }
    }
  }
}
```

Install and configure the `op` CLI with desktop-app integration. The extension runs only `op read --no-newline` with the fixed global secret reference. It starts `op` directly in Pi's terminal session, with piped output. It does not use a shell, `op run`, `OP_SERVICE_ACCOUNT_TOKEN`, or a model-facing 1Password tool.

1Password authorizes the terminal session, not the Pi session. Authorization expires after 10 minutes of inactivity or 12 hours at most. A later read can ask for Touch ID again, even if Pi is still open. Authorization can also remain valid after Pi closes. See [1Password app integration security](https://developer.1password.com/docs/cli/app-integration-security/). The provider runs one `op read` at a time, so parallel requests cannot start concurrent authorization prompts. It does not cache credentials or track authorization expiry.

A headless test on macOS 26.6.2 with `op` 2.39.0 succeeded without a controlling terminal. Two sequential reads from one Pi process needed one Touch ID prompt; a new process asked again. This still requires a user to approve the prompt in the 1Password desktop app. Unattended service or CI use is not supported by this configuration. If the app cannot authorize a read, the provider reports a sanitized failure. Do not pass a service-account token into Pi's environment.

### Bitwarden CLI

```json
{
  "credentialSource": {
    "entries": {
      "linear.apiKey": {
        "provider": "bitwarden",
        "consumers": ["linear"],
        "itemId": "12345678-1234-1234-1234-123456789abc",
        "field": "password"
      }
    }
  }
}
```

Install and sign in to the `bw` CLI. Unlock the vault outside Pi with `bw unlock --raw`. Paste the returned session key into Pi when the credential source requests it. Pi masks this input. The extension sends the session key to a constrained child-process wrapper through standard input. The wrapper sets `BW_SESSION` only in the `bw` child process. The session key does not enter the Pi environment or command arguments.

Bitwarden support currently reads the password field of a fixed item UUID. It does not accept search terms, arbitrary fields, executables, or command arguments from settings.

## Security boundary

Credential values can exist transiently in Pi process memory. The extension wraps resolved values with `Redacted<string>` and wipes the wrapper after each `use` callback. JavaScript cannot reliably zero string memory.

The extension bounds provider output, sets a timeout, sanitizes provider failures, and never stores resolved credentials in settings, files, logs, session entries, tool arguments, or tool results.
