# Private session sharing

Use `/share-private` to upload a session, `/share-private list` to find previous uploads, and `/share-private delete` to select one for removal. Native `/share` remains unchanged: it can publish to Radius or an unlisted gist. Pi's current extension API cannot reliably intercept it.

Authenticate `gh` with an account that can push to the destination GitHub.com repository. Set the destination in Pi's `settings.json`, or enter `owner/repo` at the first prompt:

```json
{
  "share": {
    "repo": "owner/private-repository",
    "branch": "session-shares"
  }
}
```

Create the branch before using it. An explicit `branch` takes precedence. Otherwise, a verified private, branch-based Pages site with a root source supplies the destination branch; the repository default is the fallback. The repository prompt saves both the repository and chosen branch as global defaults. Project settings can override them. For a symlinked settings file, edit its managed source instead.

## Viewing and privacy

Before confirming an upload, check the session, branch, and repository membership. Exports are not redacted and include tool output and all session branches. Filenames contain only the session's UTC creation date and a session-ID suffix, never its name or prompt text.

Sharing the same session again at the same destination uses the same path and link. The confirmation explicitly identifies replacement of an existing share. If the file changes after confirmation, the command stops instead of overwriting it. Earlier versions remain in Git history. Existing shares with older filenames are not renamed automatically.

Uploads require a private repository. If Pages is enabled, its visibility must also be verifiably private. The extension does not change hosting settings. A matching branch-based private Pages source provides a browser link. Deployment may take a minute or more. Otherwise, download the HTML from the GitHub file link and open it locally.

Repository and Pages settings can change between the check and upload, or after publication. Other workflows can also publish repository files. If content becomes public, anyone can access it.

## Removing a share

Delete removes the selected file from the configured branch. If Pages serves that branch, removal from the site requires a successful redeployment. Git history, forks, clones, caches, and downloaded copies can retain the content. A full takedown can require history rewriting or GitHub support.

List and delete remain available if Pages becomes public, so you can remove exposed files. They still require a private repository and push access.

After an interrupted or uncertain upload/delete, verify the named file with list or GitHub before retrying. A lost response does not mean the write failed.

See the [GitHub adapter](../.pi/extensions/share/github.ts) for destination validation and listing limits, the [commands](../.pi/extensions/share/index.ts) for confirmation and export behavior, and the [settings boundary](../.pi/extensions/_shared/settings.ts) for configuration precedence.
