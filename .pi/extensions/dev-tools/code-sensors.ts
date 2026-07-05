import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type { AgentEndFileResult } from "./agent-end";
import { AgentEndIssueSeverity as Severity, AgentEndResultKind } from "./agent-end";
import { BackendName } from "./backend-configs";

export interface CodeSensorConfig {
  version?: 1;
  sensors?: CodeSensorCommand[];
}

export interface CodeSensorCommand {
  name: string;
  command: string;
  include?: string[];
  timeoutMs?: number;
  severity?: CodeSensorSeverity;
}

export interface CodeSensorDeps {
  runCommand?: (command: string, cwd: string, timeoutMs: number) => SpawnSyncReturns<string>;
}

export const CodeSensorSeverity = {
  Error: Severity.Error,
  Warning: Severity.Warning,
} as const;
export type CodeSensorSeverity = typeof CodeSensorSeverity[keyof typeof CodeSensorSeverity];

const CONFIG_PATH = ".pi/code-sensors.json";
const DEFAULT_TIMEOUT_MS = 120_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "") ? value : undefined;
}

export function loadCodeSensorConfig(cwd: string): CodeSensorConfig | null {
  const path = join(cwd, CONFIG_PATH);
  if (!existsSync(path)) return null;

  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isObject(parsed)) throw new Error(`${CONFIG_PATH} must contain a JSON object`);

  if (parsed.version !== undefined && parsed.version !== 1) {
    throw new Error(`${CONFIG_PATH}.version must be 1`);
  }

  const rawSensors = parsed.sensors;
  if (rawSensors === undefined) return { version: 1, sensors: [] };
  if (!Array.isArray(rawSensors)) throw new Error(`${CONFIG_PATH}.sensors must be an array`);

  return {
    version: 1,
    sensors: rawSensors.map((raw, index) => {
      if (!isObject(raw)) throw new Error(`${CONFIG_PATH}.sensors[${index}] must be an object`);
      if (typeof raw.name !== "string" || raw.name.trim() === "") {
        throw new Error(`${CONFIG_PATH}.sensors[${index}].name must be a non-empty string`);
      }
      if (typeof raw.command !== "string" || raw.command.trim() === "") {
        throw new Error(`${CONFIG_PATH}.sensors[${index}].command must be a non-empty string`);
      }
      const include = asStringArray(raw.include);
      if (raw.include !== undefined && include === undefined) {
        throw new Error(`${CONFIG_PATH}.sensors[${index}].include must be an array of strings`);
      }
      if (raw.severity !== undefined && raw.severity !== CodeSensorSeverity.Error && raw.severity !== CodeSensorSeverity.Warning) {
        throw new Error(`${CONFIG_PATH}.sensors[${index}].severity must be "error" or "warning"`);
      }
      if (raw.timeoutMs !== undefined &&
        (typeof raw.timeoutMs !== "number" || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0)) {
        throw new Error(`${CONFIG_PATH}.sensors[${index}].timeoutMs must be a positive finite number`);
      }
      const timeoutMs = typeof raw.timeoutMs === "number" ? raw.timeoutMs : DEFAULT_TIMEOUT_MS;
      const severity: CodeSensorSeverity = raw.severity === undefined ? CodeSensorSeverity.Error : raw.severity;
      return { name: raw.name, command: raw.command, include, timeoutMs, severity };
    }),
  };
}

function sensorMatchesFiles(sensor: CodeSensorCommand, files: string[]): boolean {
  if (!sensor.include || sensor.include.length === 0) return true;
  return files.some((file) => sensor.include?.some((needle) => file.includes(needle)));
}

function defaultRunCommand(command: string, cwd: string, timeoutMs: number): SpawnSyncReturns<string> {
  return spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    stdio: "pipe",
    timeout: timeoutMs,
  });
}

function firstUsefulLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "command failed";
}

export async function runConfiguredCodeSensors(
  cwd: string,
  files: string[],
  deps: CodeSensorDeps = {},
): Promise<AgentEndFileResult[]> {
  const config = loadCodeSensorConfig(cwd);
  const sensors = config?.sensors ?? [];
  if (sensors.length === 0 || files.length === 0) return [];

  const runCommand = deps.runCommand ?? defaultRunCommand;
  const results: AgentEndFileResult[] = [];
  for (const sensor of sensors.filter((entry) => sensorMatchesFiles(entry, files))) {
    const run = runCommand(sensor.command, cwd, sensor.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (run.status === 0) continue;

    const detail = firstUsefulLine(run.stderr || run.stdout || `exit ${run.status ?? "unknown"}`);
    results.push({
      kind: AgentEndResultKind.Sensor,
      backend: BackendName.Sensor,
      filePath: join(cwd, CONFIG_PATH),
      fileName: CONFIG_PATH,
      issues: [{
        severity: sensor.severity ?? CodeSensorSeverity.Error,
        message: `${sensor.name}: ${detail}`,
      }],
    });
  }
  return results;
}
