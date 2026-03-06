/**
 * Permission Extension — entry point.
 *
 * Wires all components to pi's event system:
 *   - tool_call  → evaluate permissions, prompt if needed
 *   - tool_result → scan for credential leakage, redact
 *   - session_*  → reconstruct session rules
 *   - /permissions command → view rules and audit log
 *
 * No business logic here — just plumbing.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { homedir } from "os";
import { join } from "path";
import { AuditLog } from "./audit-log";
import { CredentialScanner } from "./credential-scanner";
import { PatternMatcher } from "./pattern-matcher";
import { PermissionEngine } from "./permission-engine";
import { PromptHandler } from "./prompt-handler";
import { RuleStore } from "./rule-store";
import { ThreatAnalyzer } from "./threat-analyzer";
import type { AuditEntry, RuleDefinition, SessionMode } from "./types";
import { SESSION_MODE_DESCRIPTIONS, SESSION_MODES } from "./types";

const FLAG_NAME = "permission-mode";

const PERMISSIONS_FILE = join(homedir(), ".pi", "permissions.json");
const AUDIT_FILE = join(homedir(), ".pi", "permissions-audit.jsonl");

export default function (pi: ExtensionAPI) {
  // ─── CLI Flag ────────────────────────────────────────────────────

  pi.registerFlag(FLAG_NAME, {
    description: `Start with a specific permission mode (${SESSION_MODES.join(" | ")})`,
    type: "string",
  });

  // ─── Initialize Components ──────────────────────────────────────

  const analyzer = new ThreatAnalyzer();
  const scanner = new CredentialScanner();
  const matcher = new PatternMatcher();
  const ruleStore = new RuleStore(PERMISSIONS_FILE);
  const auditLog = new AuditLog(AUDIT_FILE);
  const engine = new PermissionEngine(analyzer, matcher, ruleStore);
  const promptHandler = new PromptHandler(ruleStore);

  // ─── Session Rule Reconstruction ────────────────────────────────

  const reconstructSession = (ctx: ExtensionContext) => {
    const sessionRules: RuleDefinition[] = [];
    let sessionMode: SessionMode = ruleStore.getDefaultMode();

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "permissions-session-rule") {
        sessionRules.push(entry.data as RuleDefinition);
      }
      if (entry.type === "custom" && entry.customType === "permissions-session-mode") {
        // Last mode entry wins (most recent set wins)
        sessionMode = (entry.data as { mode: SessionMode }).mode;
      }
    }

    ruleStore.setSessionRules(sessionRules);
    ruleStore.setSessionMode(sessionMode);
  };

  pi.on("session_start", async (_event, ctx) => {
    ruleStore.reload();
    reconstructSession(ctx);

    // --permission-mode flag overrides any session-persisted mode
    const flagMode = pi.getFlag(FLAG_NAME);
    if (typeof flagMode === "string" && flagMode) {
      if (!SESSION_MODES.includes(flagMode as SessionMode)) {
        ctx.ui.notify(
          `Unknown --permission-mode "${flagMode}". Valid modes: ${SESSION_MODES.join(", ")}`,
          "warning",
        );
      } else {
        ruleStore.setSessionMode(flagMode as SessionMode);
        if (flagMode !== "default") {
          ctx.ui.notify(
            `Permission mode: ${flagMode} — ${SESSION_MODE_DESCRIPTIONS[flagMode as SessionMode]}`,
            "info",
          );
        }
      }
    }
  });

  pi.on("session_switch", async (_event, ctx) => reconstructSession(ctx));
  pi.on("session_fork", async (_event, ctx) => reconstructSession(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstructSession(ctx));

  // ─── Permission Check (tool_call) ──────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    const result = engine.evaluate(event.toolName, event.input as Record<string, unknown>);

    // Allow — log and pass through
    if (result.decision === "allow") {
      logDecision(auditLog, event.toolName, event.input, result, "allow", "rule");
      return undefined;
    }

    // Deny — log and block
    if (result.decision === "deny") {
      logDecision(auditLog, event.toolName, event.input, result, "deny", "rule");
      return { block: true, reason: result.reason };
    }

    // Review — prompt user (or block in non-interactive mode)
    if (!ctx.hasUI) {
      logDecision(auditLog, event.toolName, event.input, result, "blocked", "auto");
      return { block: true, reason: "Permission review required (no UI)" };
    }

    const userResult = await promptHandler.prompt(
      event.toolName,
      event.input as Record<string, unknown>,
      result,
      ctx,
    );

    // Log the user's decision
    logDecision(
      auditLog,
      event.toolName,
      event.input,
      result,
      userResult.decision,
      "user",
    );

    // Persist rule if user created one
    if (userResult.rule) {
      if (userResult.rule.scope === "session") {
        pi.appendEntry("permissions-session-rule", userResult.rule);
        ruleStore.addSessionRule(userResult.rule);
      } else {
        ruleStore.addRule(userResult.rule);
      }
      matcher.clearCache();
      ctx.ui.notify(`Rule added: ${userResult.rule.description}`, "info");
    }

    // Block or allow based on user decision
    if (userResult.decision === "blocked" || userResult.decision === "deny") {
      return { block: true, reason: "Blocked by user" };
    }

    return undefined;
  });

  // ─── Credential Scanning (tool_result) ─────────────────────────

  pi.on("tool_result", async (event, _ctx) => {
    // Fully redact known sensitive file reads
    if (event.toolName === "read") {
      const path = (event.input as Record<string, unknown>)?.path;
      if (typeof path === "string" && scanner.isSensitiveFileName(path)) {
        const filename = path.split("/").pop() ?? path;
        return {
          content: [
            {
              type: "text" as const,
              text: `[${filename} contents redacted by permissions extension]\n\nTo modify secrets, edit the file directly.`,
            },
          ],
        };
      }
    }

    return undefined;
  });

  // ─── Commands ──────────────────────────────────────────────────

  pi.registerCommand("permissions", {
    description: [
      "View/manage permissions. Usage:",
      "  /permissions              — show rules and current mode",
      "  /permissions mode         — show current session mode",
      "  /permissions mode <mode>  — set session mode (default | permissive | lockdown)",
      "  /permissions audit [n]    — show last n audit entries (default 20)",
    ].join("\n"),
    handler: async (args, ctx) => {
      const trimmed = args?.trim() ?? "";

      if (trimmed.startsWith("audit")) {
        const n = parseInt(trimmed.split(/\s+/)[1] ?? "20", 10);
        showAudit(auditLog, ctx, n);
        return;
      }

      if (trimmed.startsWith("mode")) {
        const parts = trimmed.split(/\s+/);
        const requested = parts[1] as SessionMode | undefined;

        if (!requested) {
          // Show current mode only
          const current = ruleStore.getSessionMode();
          ctx.ui.notify(
            `Session mode: ${current}\n${SESSION_MODE_DESCRIPTIONS[current]}`,
            "info",
          );
          return;
        }

        if (!SESSION_MODES.includes(requested)) {
          ctx.ui.notify(
            `Unknown mode "${requested}". Valid modes: ${SESSION_MODES.join(", ")}`,
            "warning",
          );
          return;
        }

        ruleStore.setSessionMode(requested);
        pi.appendEntry("permissions-session-mode", { mode: requested });
        ctx.ui.notify(
          `Session mode → ${requested}\n${SESSION_MODE_DESCRIPTIONS[requested]}`,
          "info",
        );
        return;
      }

      showRules(ruleStore, analyzer, ctx);
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────

function logDecision(
  auditLog: AuditLog,
  tool: string,
  input: unknown,
  result: { matchedRule: { id: string } | null; threats: { descriptor: { id: string } }[]; effectiveLevel: string },
  decision: AuditEntry["decision"],
  decidedBy: AuditEntry["decidedBy"],
) {
  auditLog.log({
    timestamp: Date.now(),
    tool,
    inputSummary: typeof input === "object" && input !== null
      ? Object.values(input).find((v) => typeof v === "string")?.toString().slice(0, 100) ?? ""
      : "",
    matchedRuleId: result.matchedRule?.id ?? null,
    threatIds: result.threats.map((t) => t.descriptor.id),
    decision,
    decidedBy,
    effectiveLevel: result.effectiveLevel as AuditEntry["effectiveLevel"],
  });
}

function showRules(ruleStore: RuleStore, analyzer: ThreatAnalyzer, ctx: ExtensionContext) {
  const rules = ruleStore.getAllRules();
  const global = rules.filter((r) => r.scope === "global");
  const session = rules.filter((r) => r.scope === "session");
  const mode = ruleStore.getSessionMode();

  const modeIcon = mode === "permissive" ? "🟢" : mode === "lockdown" ? "🔴" : "⚪";

  const lines: string[] = [];
  lines.push("Permission Rules");
  lines.push("─".repeat(50));
  lines.push(`\n${modeIcon} Session mode: ${mode} — ${SESSION_MODE_DESCRIPTIONS[mode]}`);
  lines.push('  (change with "/permissions mode <default|permissive|lockdown>")');
  lines.push("");

  lines.push(`\nGlobal rules (${global.length}):`);
  if (global.length === 0) lines.push("  (none)");
  for (const r of global) {
    lines.push(`  [${r.tool}] /${r.pattern}/ → ${r.action} (${r.level}) — ${r.description}`);
  }

  lines.push(`\nSession rules (${session.length}):`);
  if (session.length === 0) lines.push("  (none)");
  for (const r of session) {
    lines.push(`  [${r.tool}] /${r.pattern}/ → ${r.action} (${r.level}) — ${r.description}`);
  }

  lines.push(`\nThreat patterns: ${analyzer.getDescriptorCount()}`);
  lines.push('Use "/permissions audit [n]" to view recent decisions');

  ctx.ui.notify(lines.join("\n"), "info");
}

function showAudit(auditLog: AuditLog, ctx: ExtensionContext, n: number) {
  const entries = auditLog.getRecent(n);
  if (entries.length === 0) {
    ctx.ui.notify("No audit entries yet", "info");
    return;
  }

  const lines = entries.map((e) => {
    const time = new Date(e.timestamp).toLocaleTimeString();
    const threats = e.threatIds.length > 0 ? ` ⚡${e.threatIds.length}` : "";
    return `[${time}] ${e.decision.padEnd(10)} ${e.tool.padEnd(6)} ${e.inputSummary.slice(0, 60)}${threats}`;
  });

  ctx.ui.notify(`Recent decisions (${entries.length}):\n${lines.join("\n")}`, "info");
}
