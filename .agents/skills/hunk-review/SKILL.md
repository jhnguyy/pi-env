---
name: hunk-review
description: Guide an interactive Hunk review in a user-opened session, with worktree-safe selection and user-note replies.
---

# Hunk Review

Run `hunk skill show hunk-review` and read the complete output before using Hunk. The installed CLI owns command syntax and version-matched guidance; apply these local safeguards over its defaults. If Hunk is unavailable, follow [setup](../../../docs/setup.md#optional-hunk-review).

- Ask the user to open the TUI; do not launch interactive commands yourself. The CLI and TUI must share the same host, OS user, and loopback access. If discovery fails, diagnose that boundary; never restart the daemon unprompted.
- Discover sessions, then inspect metadata and review structure. Bind an explicit session ID only after verifying the exact worktree path, loaded review source, and requested scope (revision/range and path filters). A shared repository or a lone session is not enough. Ask if the intended session or scope remains ambiguous. Use that ID on every subsequent session command, not implicit selection or `--repo` alone.
- Select the relevant discussion: explain intent, decisions, risks, and useful follow-ups, not a transcript or a note on every hunk. Start with structural review data; request raw patches only when needed.
- After edits or any reload, refresh session metadata and review structure before further mutations. Revalidate the worktree, source, scope, and current file/side/line anchors; do not reuse stale anchors or note IDs.
- Read user notes with `hunk session comment list <session-id> --type user --json`. Reply using the returned note ID via `--reply-to`, after checking it still exists. Prefix AI-authored conversational comments and replies with `🤖:`. Preserve any quoted user text unchanged and before the AI contribution. Bring decisions and unresolved feedback back into the Pi conversation; reading notes does not authorize implementation or publication.
- Never erase user notes. Capture important feedback in the Pi conversation before closing or replacing the review. Ask for confirmation before replacing review contents (including reloads), and explain possible note loss first. Do not clear notes as routine cleanup. Ask before any daemon restart and explain its effect on attached windows; revalidate the session afterward.
