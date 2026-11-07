/**
 * @module _shared/code-frame
 * @purpose Shared helpers for stack remapping and code-frame snippets.
 */

export function formatParamsPreview(params: Record<string, unknown>, maxChars = 240): string {
  try {
    const raw = JSON.stringify(params);
    return raw.length > maxChars ? raw.substring(0, maxChars) + "…" : raw;
  } catch {
    return "[unserializable args]";
  }
}

export function mapGeneratedStackToUserLine(
  generatedPath: string,
  message: string,
  stack: string,
  userStartLine: number,
): { userLine: number; column?: number } | null {
  const re = new RegExp(`${escapeRegex(generatedPath)}:(\\d+):(\\d+)`);
  const hay = `${message}\n${stack}`;
  const m = hay.match(re);
  if (!m) return null;
  const generatedLine = Number(m[1]);
  const col = Number(m[2]);
  const userLine = generatedLine - userStartLine + 1;
  if (userLine < 1) return null;
  return { userLine, column: Number.isFinite(col) ? col : undefined };
}

export function buildCodeFrame(source: string, line: number): string {
  const lines = source.split("\n");
  const start = Math.max(1, line - 2);
  const end = Math.min(lines.length, line + 1);
  const width = String(end).length;
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    const n = String(i).padStart(width, " ");
    out.push(`${n} | ${lines[i - 1] ?? ""}`);
    if (i === line) out.push(`${" ".repeat(width)} | ^`);
  }
  return out.join("\n");
}

function escapeRegex(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
