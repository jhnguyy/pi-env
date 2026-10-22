# Private session sharing

Use `/share-private` for private-repository uploads. Native `/share` remains unchanged: it can publish to Radius or an unlisted gist. Pi's extension API cannot reliably intercept that command.

Authenticate `gh` with an account that can push to the destination GitHub.com repository. Set the default in Pi's `settings.json`, or enter `owner/repo` when `/share-private` prompts:

```json
{
  "share": {
    "repo": "owner/private-repository"
  }
}
```

The prompt saves a global default. Project settings can override it. For a symlinked settings file, set `share.repo` in its managed source instead.

Before you confirm an upload, check the session and repository membership. Exports are not redacted and include tool output and all session branches. Repository visibility can change between the privacy check and upload, or after publication. If the repository becomes public, anyone can access the shared file.

Download the HTML from the returned GitHub file link and open it locally. Deleting a shared file does not erase its repository history.

See the [share command](../.pi/extensions/share/index.ts) for publication checks and limits, and the [settings boundary](../.pi/extensions/_shared/settings.ts) for configuration precedence.
