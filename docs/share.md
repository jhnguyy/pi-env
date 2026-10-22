# Private session sharing

The pi-env share extension routes terminal `/share` to `/share-private`. Use `/share-private` directly in RPC clients or when another extension replaces the editor after startup.

Authenticate the GitHub CLI with an account that can push to the destination repository. The extension supports GitHub.com repositories only. It does not create repositories.

Set the destination in your Pi `settings.json`:

```json
{
  "share": {
    "repo": "owner/private-repository"
  }
}
```

If no destination is configured, `/share` asks for one. It validates the repository before saving it as the global default. Project settings can override that default. Edit `share.repo` to change the destination.

Before each upload, Pi asks for confirmation. The export is not redacted. It includes session branches and tool output, which can contain sensitive information. Check the session and repository membership before you confirm.

The result is an authenticated GitHub file link. Download the HTML file and open it locally to view the session. The extension does not use a public viewer or a gist. Each upload creates a new file, so repeated shares remain in repository history. Deleting a file does not erase its history.

See the [share command](../.pi/extensions/share/index.ts) for publication limits and the [settings boundary](../.pi/extensions/_shared/settings.ts) for configuration precedence.
