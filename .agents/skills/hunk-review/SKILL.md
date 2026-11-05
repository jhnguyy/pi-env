---
name: hunk-review
description: Guide an interactive Hunk review in a user-opened session, explain changes with inline notes, and collect and answer user feedback.
---

# Hunk Review

## Select the review

Have the user run `hunk diff` in the intended worktree, or open the requested comparison in Hunk. Control that window with `hunk session` commands, not an interactive viewer launched by the agent. The CLI and TUI need the same host, OS user, and loopback access; a remote terminal or container may not share that boundary.

```bash
hunk session list --json
hunk session get <session-id> --json
hunk session review <session-id> --json
```

Replace `<session-id>` with the discovered ID. Verify the exact worktree, loaded source, revision or range, and path filters against the requested review. Neither a shared repository nor a single running window establishes the right scope. Resolve ambiguity before steering the window, then use the verified ID throughout.

## Inspect the changes

Start with the file and hunk structure returned by `review`. Read raw patches only where needed:

```bash
hunk session review <session-id> --include-patch --json
hunk session context <session-id> --json
```

Use context to see the user's current focus. Choose a short review path through intent, consequential decisions, risks, and open questions rather than covering every hunk. After edits or a reload, inspect the metadata and review again and verify anchors against the current content. Use repository-relative file paths and the correct old or new side: deleted lines belong to the old side; added lines belong to the new side.

## Guide the discussion

Navigate to the code under discussion. Hunk numbers and line numbers are 1-based; select exactly one target:

```bash
hunk session navigate <session-id> --file src/example.ts --hunk 2
hunk session navigate <session-id> --file src/example.ts --old-line 35
hunk session navigate <session-id> --file src/example.ts --new-line 42
```

Add a note at a verified line, using exactly one line side. The paths, anchors, and text below are examples to replace with the current review's values:

```bash
hunk session comment add <session-id> --file src/example.ts --new-line 42 --summary '🤖: This moves resource ownership to the caller.' --rationale '🤖: Check that every caller releases the resource on failure.' --focus --json
```

`--focus` moves the viewport and reveals agent notes, which start hidden. Use it on the first note, then only when useful for directing attention; the user can also toggle agent notes with `a`. For several prepared notes, send one batch:

```bash
printf '%s\n' '{"comments":[{"filePath":"src/example.ts","newLine":42,"summary":"🤖: This moves resource ownership to the caller."}]}' | hunk session comment apply <session-id> --stdin --focus --json
```

Explain what matters in Pi as you guide the view; inline notes should support the discussion, not replace it.

## Collect feedback

The user can press `c` in Hunk to leave a note. Read user notes and reply to the returned note ID after confirming it is still current:

```bash
hunk session comment list <session-id> --type user --json
hunk session comment add <session-id> --reply-to <note-id> --summary '🤖: Agreed; this remains an open follow-up.' --json
```

Replies inherit the parent note's anchor. Revisit the relevant code before answering a question about behavior. Distinguish agreement, a proposed change, and a verified fix.

## Summarize and preserve

Bring decisions, user feedback, unresolved questions, and verification limits back into the Pi conversation. Hunk's live notes are ephemeral: preserve important discussion before closing a session, replacing its contents, or restarting the daemon. Do not clear notes as routine cleanup.

Ask before disrupting the review with a reload or daemon restart, explaining the possible loss of notes and effect on attached windows. If discovery fails while the user's TUI is open, check the host/user/loopback boundary or reported build mismatch before proposing a restart. After any disruption, rediscover the session and revalidate its worktree, scope, and anchors.
