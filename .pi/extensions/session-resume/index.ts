import { existsSync, realpathSync, writeFileSync } from "node:fs";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
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

function canonicalSessions(sessions: readonly SessionInfo[]): SessionInfo[] {
  return sessions.map((session) => ({
    ...session,
    path: canonicalPath(session.path) ?? session.path,
    parentSessionPath: canonicalPath(session.parentSessionPath),
  }));
}

export async function loadSessionScopes(
  ctx: ExtensionContext,
  cwd: string,
  forceDefaultStorage: boolean,
): Promise<{ current: SessionInfo[]; all: SessionInfo[] }> {
  const defaultCurrent = await SessionManager.list(cwd);
  const currentFile = canonicalPath(ctx.sessionManager.getSessionFile());
  const usesDefaultStorage =
    forceDefaultStorage ||
    (currentFile !== undefined &&
      defaultCurrent.some((session) => canonicalPath(session.path) === currentFile));
  if (usesDefaultStorage) {
    return { current: defaultCurrent, all: await SessionManager.listAll() };
  }

  const sessionDir = ctx.sessionManager.getSessionDir();
  return {
    current: await SessionManager.list(cwd, sessionDir),
    all: await SessionManager.listAll(sessionDir),
  };
}

async function pickSession(
  ctx: ExtensionContext,
  cwd: string,
  forceDefaultStorage = false,
): Promise<string | undefined> {
  if (ctx.mode !== "tui") return undefined;
  const sessions = await loadSessionScopes(ctx, cwd, forceDefaultStorage);
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const picker = new SessionResumePicker(
      { current: canonicalSessions(sessions.current), all: canonicalSessions(sessions.all) },
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

async function resumeFromCommand(ctx: ExtensionCommandContext): Promise<void> {
  const selectedPath = await pickSession(ctx, ctx.cwd);
  if (!selectedPath) return;
  const result = await ctx.switchSession(selectedPath);
  if (result.cancelled) ctx.ui.notify("Session switch cancelled", "info");
}

export default function sessionResume(pi: ExtensionAPI): void {
  const startupRequest = consumeStartupResumeRequest();

  pi.registerCommand("resume-tree", {
    description: "Resume a session from a foldable parent-first tree",
    handler: async (_args, ctx) => resumeFromCommand(ctx),
  });

  if (!startupRequest) return;
  pi.on("session_start", async (_event, ctx) => {
    try {
      if (!existsSync(startupRequest.selectionFile)) return;
      const selectedPath = await pickSession(ctx, startupRequest.cwd, true);
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
