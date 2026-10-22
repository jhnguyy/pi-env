import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Data, Effect, Schema } from "effect";
import { decodeSettingsBlockEffect, defaultSettingsEnv, SettingsDecodeError, type SettingsEnv, SettingsReadError, SettingsWriteError, updateGlobalSettingsBlockEffect } from "../_shared/settings";

const Repo = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/));
const ShareSettings = Schema.Struct({ repo: Schema.optionalKey(Repo) });
const Repository = Schema.Struct({ id: Schema.Number, private: Schema.Boolean, permissions: Schema.Struct({ push: Schema.Boolean }) });
const Upload = Schema.Struct({ content: Schema.Struct({ html_url: Schema.String }) });
const MaxExportBytes = 10 * 1024 * 1024;

class ShareError extends Data.TaggedError("ShareError")<{ readonly message: string; readonly cause?: unknown }> {}

function io<A>(message: string, action: () => Promise<A>) {
  return Effect.tryPromise({ try: action, catch: (cause) => new ShareError({ message, cause }) });
}

function execute(pi: ExtensionAPI, ctx: ExtensionCommandContext, binary: string, args: string[]) {
  return Effect.flatMap(io(`Could not run ${binary}. Check that it is installed.`, () => pi.exec(binary, args, { cwd: ctx.cwd, timeout: 120_000 })), (result) =>
    result.code === 0 && !result.killed
      ? Effect.succeed(result.stdout)
      : Effect.fail(new ShareError({ message: `${binary} failed: ${result.stderr.trim() || `exit ${result.code}`}` })));
}

function json(text: string) {
  return Effect.try({ try: () => JSON.parse(text) as unknown, catch: (cause) => new ShareError({ message: "GitHub returned invalid JSON.", cause }) });
}

function inspectRepository(pi: ExtensionAPI, ctx: ExtensionCommandContext, repo: string) {
  return Effect.gen(function* () {
    const response = yield* execute(pi, ctx, "gh", ["api", "--hostname", "github.com", `repos/${repo}`]);
    const repository = yield* Schema.decodeUnknownEffect(Repository)(yield* json(response));
    if (!repository.private || !repository.permissions.push) {
      return yield* new ShareError({ message: "The repository must be private and your GitHub account must have push access." });
    }
    return repository;
  });
}

function publish(pi: ExtensionAPI, ctx: ExtensionCommandContext, env: SettingsEnv) {
  return Effect.gen(function* () {
    if (!ctx.hasUI) return yield* new ShareError({ message: "Run /share-private interactively to choose and confirm its private destination." });
    yield* io("Could not wait for the session to become idle.", () => ctx.waitForIdle());
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return yield* new ShareError({ message: "This session has no saved session file to export." });
    const settings = yield* decodeSettingsBlockEffect("share", ShareSettings, ctx.cwd, env);
    const input = settings.repo ?? (yield* io("Could not prompt for a repository.", () => ctx.ui.input("Private GitHub repository (saved as your default)", "owner/repo")));
    if (input === undefined) return;
    const repo = yield* Schema.decodeUnknownEffect(Repo)(input.trim());
    const repository = yield* inspectRepository(pi, ctx, repo);
    if (!settings.repo) {
      yield* updateGlobalSettingsBlockEffect("share", { repo }, env);
      ctx.ui.notify(`Default share repository saved: ${repo}`, "info");
    }
    const approved = yield* io("Could not confirm publication.", () => ctx.ui.confirm("Publish session", `Upload the full session export, including tool output and all branches, to ${repo}? Repository readers can access it. Content is not redacted.`));
    if (!approved) return;
    yield* Effect.scoped(Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        io("Could not create the export directory.", () => mkdtemp(join(tmpdir(), "pi-share-"))),
        (path) => io("Could not remove the temporary export.", () => rm(path, { recursive: true, force: true })).pipe(Effect.orDie),
      );
      const html = join(directory, "session.html");
      yield* execute(pi, ctx, "pi", ["--export", sessionFile, html]);
      const size = yield* io("Could not inspect the exported session.", () => stat(html));
      if (size.size > MaxExportBytes) return yield* new ShareError({ message: "The session export exceeds the 10 MiB share limit. Use /export to save it locally." });
      const content = yield* io("Could not read the exported session.", () => readFile(html));
      const payload = join(directory, "upload.json");
      yield* io("Could not prepare the upload.", () => writeFile(payload, JSON.stringify({ message: "Share Pi session", content: content.toString("base64") }), { mode: 0o600 }));
      const path = `sessions/${randomUUID()}.html`;
      const current = yield* inspectRepository(pi, ctx, repo);
      if (current.id !== repository.id) return yield* new ShareError({ message: "The repository changed after confirmation. Run /share-private again to confirm its destination." });
      const response = yield* execute(pi, ctx, "gh", ["api", "--hostname", "github.com", "--method", "PUT", `repos/${repo}/contents/${path}`, "--input", payload]);
      const upload = yield* Schema.decodeUnknownEffect(Upload)(yield* json(response));
      ctx.ui.notify(`Shared privately: ${upload.content.html_url}\nDownload the HTML file to view the session.`, "info");
    }));
  });
}

function failureMessage(error: unknown): string {
  if (error instanceof SettingsReadError) return `Could not read ${error.source} settings at ${error.path}.`;
  if (error instanceof SettingsDecodeError) return `Invalid ${error.source} settings at ${error.path}${error.key ? ` (${error.key})` : ""}.`;
  if (error instanceof ShareError || error instanceof SettingsWriteError) return error.message;
  return "Invalid repository name or GitHub response. Use owner/repo and check repository privacy and push access.";
}

export default function share(pi: ExtensionAPI, env: SettingsEnv = defaultSettingsEnv): void {
  pi.registerCommand("share-private", {
    description: "Publish the session HTML to your private GitHub repository",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await Effect.runPromise(publish(pi, ctx, env).pipe(Effect.catch((error) => Effect.sync(() => {
        ctx.ui.notify(`Share failed: ${failureMessage(error)}`, "error");
      }))));
    },
  });
}
