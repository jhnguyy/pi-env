import { existsSync, realpathSync, writeFileSync } from "node:fs";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { ResumeSession } from "./model";
import { SessionResumePicker } from "./picker";

const StartupResumeEnvironment = Object.freeze({
  Enabled: "PI_ENV_SESSION_RESUME",
  Cwd: "PI_ENV_SESSION_RESUME_CWD",
  SelectionFile: "PI_ENV_SESSION_RESUME_FILE",
});

interface StartupResumeRequest {
  readonly cwd: string;
  readonly selectionFile: string;
}

function consumeStartupResumeRequest(): StartupResumeRequest | undefined {
  const enabled = process.env[StartupResumeEnvironment.Enabled];
  const cwd = process.env[StartupResumeEnvironment.Cwd];
  const selectionFile = process.env[StartupResumeEnvironment.SelectionFile];
  delete process.env[StartupResumeEnvironment.Enabled];
  delete process.env[StartupResumeEnvironment.Cwd];
  delete process.env[StartupResumeEnvironment.SelectionFile];
  if (enabled !== "1" || !cwd || !selectionFile) return undefined;
  return { cwd, selectionFile };
}

function canonicalPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function toResumeSession(session: SessionInfo): ResumeSession {
  const path = canonicalPath(session.path) ?? session.path;
  const title = session.name ?? session.firstMessage;
  return {
    path,
    parentPath: canonicalPath(session.parentSessionPath),
    cwd: session.cwd,
    title,
    searchText: [title, session.cwd, path].join("\n").toLocaleLowerCase(),
    modifiedAt: session.modified.getTime(),
  };
}

async function pickSession(ctx: ExtensionContext, cwd: string): Promise<string | undefined> {
  if (ctx.mode !== "tui") return undefined;
  const [current, all] = await Promise.all([SessionManager.list(cwd), SessionManager.listAll()]);
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const picker = new SessionResumePicker(
      { current: current.map(toResumeSession), all: all.map(toResumeSession) },
      theme,
      keybindings,
      done,
    );
    return {
      get focused() {
        return picker.focused;
      },
      set focused(value: boolean) {
        picker.focused = value;
      },
      render: (width) => picker.render(width),
      handleInput: (data) => {
        picker.handleInput(data);
        tui.requestRender();
      },
      invalidate: () => picker.invalidate(),
    };
  });
}

export default function sessionResume(pi: ExtensionAPI): void {
  const startupRequest = consumeStartupResumeRequest();
  if (!startupRequest) return;
  pi.on("session_start", async (_event, ctx) => {
    try {
      if (!existsSync(startupRequest.selectionFile)) return;
      const selectedPath = await pickSession(ctx, startupRequest.cwd);
      if (selectedPath)
        writeFileSync(startupRequest.selectionFile, selectedPath, {
          encoding: "utf8",
          mode: 0o600,
        });
    } finally {
      ctx.shutdown();
    }
  });
}
