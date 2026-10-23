# Private session sharing

Use `/share` to upload a session, `/share list` to find previous uploads, and `/share delete` to select one for removal. `/share-private` remains an alias.

The pi-env runtime gives the extension explicit ownership of native `/share`. A canceled or failed claimed command cannot fall through to native sharing. Restart Pi after installing runtime changes. `/reload` cannot replace the core dispatcher.

Setup and the generated launcher reject runtimes without the required hook. If you load the extension through an unmanaged older Pi, it warns and exposes only `/share-private`. Native `/share` in that older runtime can still publish through Radius or a gist. See [runtime patch ownership](nix.md#local-command-override-patch).

Authenticate `gh` with an account that can push to the destination GitHub.com repository. Set the destination in Pi's `settings.json`, or enter `owner/repo` at the first prompt:

```json
{
  "share": {
    "repo": "owner/private-repository",
    "branch": "session-shares"
  }
}
```

Create the branch before using it. Omit `branch` to use the repository's default branch. The repository prompt saves a global default. Project settings can override it. For a symlinked settings file, edit its managed source instead.

## Viewing and privacy

Before confirming an upload, check the session, branch, and repository membership. Exports are not redacted and include tool output and all session branches. Filenames use the session name or first prompt, so they can also reveal session details.

Uploads require a private repository. If Pages is enabled, its visibility must also be verifiably private. The extension does not change hosting settings. A matching branch-based private Pages source provides a browser link. Deployment may take a minute or more. Otherwise, download the HTML from the GitHub file link and open it locally.

Repository and Pages settings can change between the check and upload, or after publication. Other workflows can also publish repository files. If content becomes public, anyone can access it.

## Removing a share

Delete removes the selected file from the configured branch. If Pages serves that branch, removal from the site requires a successful redeployment. Git history, forks, clones, caches, and downloaded copies can retain the content. A full takedown can require history rewriting or GitHub support.

List and delete remain available if Pages becomes public, so you can remove exposed files. They still require a private repository and push access.

After an interrupted or uncertain upload/delete, verify the named file with list or GitHub before retrying. A lost response does not mean the write failed.

See the [GitHub adapter](../.pi/extensions/share/github.ts) for destination validation and listing limits, the [commands](../.pi/extensions/share/index.ts) for confirmation and export behavior, and the [settings boundary](../.pi/extensions/_shared/settings.ts) for configuration precedence.
