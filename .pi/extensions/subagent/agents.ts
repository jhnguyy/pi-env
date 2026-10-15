/**
 * Agent discovery and configuration
 *
 * Ported from node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/agents.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  getAgentDir,
  parseFrontmatter,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project";
export type AgentSource = "user" | "package" | "project";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  capabilities?: string[];
  model?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

function parseToolList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const values = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 || Array.isArray(value) ? values : undefined;
}

function loadAgentFile(filePath: string, source: AgentSource): AgentConfig | undefined {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
  if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") return undefined;
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    tools: parseToolList(frontmatter.tools),
    capabilities: parseToolList(frontmatter.capabilities),
    model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
    systemPrompt: body,
    source,
    filePath,
  };
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!entry.name.endsWith(".md")) return [];
    if (!entry.isFile() && !entry.isSymbolicLink()) return [];
    const agent = loadAgentFile(path.join(dir, entry.name), source);
    return agent ? [agent] : [];
  });
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function loadAgentsFromPackages(cwd: string, scope: AgentScope): AgentConfig[] {
  const agents: AgentConfig[] = [];
  try {
    const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: scope === "project" });
    const packageManager = new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager: settings });
    // Named agents are extension-owned, not a native package resource type.
    for (const pkg of packageManager.listConfiguredPackages()) {
      if (pkg.scope !== scope || !pkg.installedPath) continue;
      const agentsDir = path.join(pkg.installedPath, CONFIG_DIR_NAME, "agents");
      agents.push(...loadAgentsFromDir(agentsDir, scope === "user" ? "package" : "project"));
    }
  } catch {
    // settings.json unavailable or malformed — skip package scanning
  }
  return agents;
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const userAgents = scope === "user" ? loadAgentsFromDir(userDir, "user") : [];
  const packageAgents = loadAgentsFromPackages(cwd, scope);
  const projectAgents =
    scope === "project" && projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project") : [];

  const agentMap = new Map<string, AgentConfig>();
  for (const agent of [...packageAgents, ...projectAgents]) {
    agentMap.set(agent.name, agent);
  }
  for (const agent of userAgents) agentMap.set(agent.name, agent);

  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(
  agents: AgentConfig[],
  maxItems: number,
): { text: string; remaining: number } {
  if (agents.length === 0) return { text: "none", remaining: 0 };
  const listed = agents.slice(0, maxItems);
  const remaining = agents.length - listed.length;
  return {
    text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
    remaining,
  };
}
