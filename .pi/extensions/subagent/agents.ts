/**
 * Agent discovery and configuration
 *
 * Ported from node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/agents.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CONFIG_DIR_NAME,
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

function commaList(value: string | undefined): string[] | undefined {
  const values = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values && values.length > 0 ? values : undefined;
}

function loadAgentFile(filePath: string, source: AgentSource): AgentConfig | undefined {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
  const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
  if (!frontmatter.name || !frontmatter.description) return undefined;
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    tools: commaList(frontmatter.tools),
    capabilities: commaList(frontmatter.capabilities),
    model: frontmatter.model,
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

/**
 * Load agent definitions from all registered pi packages (settings.json `packages`).
 * This mirrors how extensions and skills are discovered from packages — enabling
 * a repo like pi-env to ship agent definitions that are globally available once
 * the repo is registered as a package, without requiring symlinks or cwd proximity.
 */
function loadAgentsFromPackages(cwd: string): AgentConfig[] {
  const agents: AgentConfig[] = [];
  try {
    const settings = SettingsManager.create(cwd);
    const packages = settings.getPackages();
    for (const pkg of packages) {
      const source = typeof pkg === "string" ? pkg : pkg.source;
      if (!source || !fs.existsSync(source)) continue;
      const agentsDir = path.join(source, CONFIG_DIR_NAME, "agents");
      agents.push(...loadAgentsFromDir(agentsDir, "package"));
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
  const packageAgents = scope === "user" ? loadAgentsFromPackages(cwd) : [];
  const projectAgents =
    scope === "project" && projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project") : [];

  const agentMap = new Map<string, AgentConfig>();
  for (const agent of scope === "project" ? projectAgents : packageAgents) {
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
