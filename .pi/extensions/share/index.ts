import * as nodeFiles from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Clock, Effect, Schema } from "effect";
import { execEffect } from "../_shared/exec";
import { generateId } from "../_shared/id";
import { slugify } from "../_shared/slug";
import { decodeSettingsBlockEffect, defaultSettingsEnv, SettingsDecodeError, type SettingsEnv, SettingsReadError, SettingsWriteError, updateGlobalSettingsBlockEffect } from "../_shared/settings";
import { deleteShare, inspectTarget, listShares, mutationFailure, privatePagesBase, RepositoryName, SharePath, revalidateTarget, ShareError, shareFailure, type ShareFile, type ShareTarget, uploadShare } from "./github";

const ShareSettings = Schema.Struct({ repo: Schema.optionalKey(RepositoryName), branch: Schema.optionalKey(Schema.NonEmptyString) });
const Actions = ["upload", "list", "delete"];
const MaxExportBytes = 10 * 1024 * 1024;

export type ShareFiles = Pick<typeof nodeFiles, "mkdtemp" | "readFile" | "rm" | "stat" | "writeFile">;

function io<A>(message: string, action: () => Promise<A>) {
  return Effect.tryPromise({ try: action, catch: (cause) => shareFailure(message, cause) });
}

function sessionTitle(manager: ExtensionCommandContext["sessionManager"]): string {
  const name = manager.getSessionName();
  if (name) return name;
  const entry = manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
  if (entry?.type !== "message" || entry.message.role !== "user") return "session";
  const content = entry.message.content;
  return typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text).join(" ");
}

function viewUrl(base: string | undefined, file: ShareFile): string {
  return base ? new URL(file.path, `${base.replace(/\/+$/, "")}/`).href : file.htmlUrl;
}

function publish(pi: ExtensionAPI, ctx: ExtensionCommandContext, target: ShareTarget, sessionFile: string, files: ShareFiles) {
  return Effect.gen(function* () {
    const date = new Date(yield* Clock.currentTimeMillis).toISOString().slice(0, 10);
    const path = yield* Schema.decodeUnknownEffect(SharePath)(`sessions/${date}-${slugify(sessionTitle(ctx.sessionManager), { fallback: "session" })}-${generateId(6)}.html`);
    const approved = yield* io("Could not confirm publication.", () => ctx.ui.confirm("Publish session", `Upload the full, unredacted session export, including tool output and all branches, to ${target.repo}@${target.branch}:${path}? Repository readers can access it.`));
    if (!approved) return;
    yield* Effect.scoped(Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        io("Could not create the export directory.", () => files.mkdtemp(join(tmpdir(), "pi-share-"))),
        (path) => io(`Could not remove ${path}.`, () => files.rm(path, { recursive: true, force: true })).pipe(
          Effect.catch((error) => Effect.sync(() => ctx.ui.notify(`${error.message} It may contain sensitive session data. Remove the directory manually.`, "warning"))),
        ),
      );
      const html = join(directory, "session.html");
      yield* execEffect(pi.exec, "pi", ["--export", sessionFile, html], shareFailure, { cwd: ctx.cwd });
      const size = yield* io("Could not inspect the exported session.", () => files.stat(html));
      if (size.size > MaxExportBytes) return yield* shareFailure("The session export exceeds the 10 MiB share limit. Use /export to save it locally.");
      const content = yield* io("Could not read the exported session.", () => files.readFile(html));
      const payload = join(directory, "upload.json");
      yield* io("Could not prepare the upload.", () => files.writeFile(payload, JSON.stringify({ message: "Share Pi session", branch: target.branch, content: content.toString("base64") }), { mode: 0o600 }));
      const current = yield* revalidateTarget(pi.exec, ctx.cwd, target);
      const pages = yield* privatePagesBase(pi.exec, ctx.cwd, current);
      const blob = yield* uploadShare(pi.exec, ctx.cwd, current, path, payload).pipe(
        Effect.onInterrupt(() => Effect.sync(() => ctx.ui.notify(mutationFailure("upload", current, path, "uncertain", undefined).message, "warning"))),
      );
      const url = pages ? new URL(path, `${pages.replace(/\/+$/, "")}/`).href : blob;
      ctx.ui.notify(`Shared privately: ${url}\n${pages ? "Private Pages may take a minute or more to deploy." : "Download the HTML file to view the session."}`, "info");
    }));
  });
}

function manage(pi: ExtensionAPI, ctx: ExtensionCommandContext, target: ShareTarget, action: "list" | "delete") {
  return Effect.gen(function* () {
    const shares = yield* listShares(pi.exec, ctx.cwd, target);
    if (shares.length === 0) {
      ctx.ui.notify(`No shares in ${target.repo}@${target.branch}.`, "info");
      return;
    }
    const pages = yield* privatePagesBase(pi.exec, ctx.cwd, target).pipe(Effect.catch(() => Effect.sync(() => {
      ctx.ui.notify("Pages is public or could not be verified. Showing repository links only. Uploads remain blocked.", "warning");
      return undefined;
    })));
    if (action === "list") {
      ctx.ui.notify(shares.map((file) => `${file.name}\n${file.path}\n${viewUrl(pages, file)}`).join("\n\n"), "info");
      return;
    }
    const selection = yield* io("Could not select a share.", () => ctx.ui.select(`Delete share from ${target.repo}@${target.branch}`, shares.map((file) => file.path)));
    if (selection === undefined) return;
    const file = shares.find((file) => file.path === selection);
    if (!file) return yield* shareFailure("The selected file is not one of the listed shares.");
    const approved = yield* io("Could not confirm deletion.", () => ctx.ui.confirm("Delete shared session", `Delete ${file.path} from ${target.repo}@${target.branch}? Git history and downloaded copies remain. Pages removal requires redeployment.`));
    if (!approved) return;
    const current = yield* revalidateTarget(pi.exec, ctx.cwd, target);
    yield* deleteShare(pi.exec, ctx.cwd, current, file).pipe(
      Effect.onInterrupt(() => Effect.sync(() => ctx.ui.notify(mutationFailure("delete", current, file.path, "uncertain", undefined).message, "warning"))),
    );
    ctx.ui.notify(`Deleted ${file.path} from ${target.repo}@${target.branch}. Pages removal follows redeployment. Git history and downloaded copies remain.`, "info");
  });
}

function runShare(args: string, pi: ExtensionAPI, ctx: ExtensionCommandContext, env: SettingsEnv, files: ShareFiles) {
  return Effect.gen(function* () {
    const action = args.trim() || "upload";
    if (!Actions.includes(action)) return yield* shareFailure("Usage: /share-private [upload|list|delete]");
    if (!ctx.hasUI) return yield* shareFailure("Run /share-private interactively to choose and confirm its private destination.");
    yield* io("Could not wait for the session to become idle.", () => ctx.waitForIdle());
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (action === "upload" && !sessionFile) return yield* shareFailure("This session has no saved session file to export.");
    const settings = yield* decodeSettingsBlockEffect("share", ShareSettings, ctx.cwd, env);
    const repo = settings.repo ?? (yield* io("Could not prompt for a repository.", () => ctx.ui.input("Private GitHub repository (saved as your default)", "owner/repo")).pipe(
      Effect.flatMap((input) => input === undefined ? Effect.void : Schema.decodeUnknownEffect(RepositoryName)(input.trim())),
    ));
    if (repo === undefined) return;
    const target = yield* inspectTarget(pi.exec, ctx.cwd, repo, settings.branch);
    if (action === "upload") yield* privatePagesBase(pi.exec, ctx.cwd, target);
    if (!settings.repo) {
      yield* updateGlobalSettingsBlockEffect("share", { repo }, env);
      ctx.ui.notify(`Default share repository saved: ${repo}`, "info");
    }
    if (action === "upload" && sessionFile) yield* publish(pi, ctx, target, sessionFile, files);
    else if (action === "list" || action === "delete") yield* manage(pi, ctx, target, action);
  });
}

function failureMessage(error: unknown): string {
  if (error instanceof SettingsReadError) return `Could not read ${error.source} settings at ${error.path}.`;
  if (error instanceof SettingsDecodeError) return `Invalid ${error.source} settings at ${error.path}${error.key ? ` (${error.key})` : ""}.`;
  if (error instanceof ShareError || error instanceof SettingsWriteError) return error.message;
  return "Invalid share settings or GitHub response. Check the repository, branch, Pages visibility, and push access.";
}

export default function share(pi: ExtensionAPI, env: SettingsEnv = defaultSettingsEnv, files: ShareFiles = nodeFiles): void {
  pi.registerCommand("share-private", {
    description: "Publish, list, or delete session exports in a private GitHub repository",
    getArgumentCompletions: (prefix) => Actions.flatMap((action) => action.startsWith(prefix) ? [{ value: action, label: action }] : []),
    handler: async (args, ctx) => {
      await Effect.runPromise(runShare(args, pi, ctx, env, files).pipe(Effect.catch((error) => Effect.sync(() => {
        if (error instanceof ShareError && error.mutationOutcome) ctx.ui.notify(error.message, "warning");
        else ctx.ui.notify(`Share failed: ${failureMessage(error)}`, "error");
      }))), { signal: ctx.signal });
    },
  });
}
