import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  formatSkillsForPrompt,
  ModelRuntime,
  parseSkillBlock,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const referenceNames = [
  "architecture-friction-review",
  "distillation",
  "grill",
  "handoff",
  "index-generator",
  "planning",
  "teach",
];
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function loadPackageSkills() {
  const root = mkdtempSync(join(tmpdir(), "native-reference-skills-"));
  roots.push(root);
  vi.stubEnv("HOME", root);
  const packageDir = join(root, "package");
  const referenceDir = join(packageDir, ".agents", "skills", "reference");
  cpSync(join(repository, ".agents", "skills", "reference"), referenceDir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "reference-skill-fixture", pi: { skills: manifest.pi.skills } }),
  );
  const visibleDir = join(packageDir, ".agents", "skills", "visible-control");
  mkdirSync(visibleDir);
  writeFileSync(
    join(visibleDir, "SKILL.md"),
    "---\nname: visible-control\ndescription: Visible prompt control.\n---\n\nVisible instructions.\n",
  );
  const agentDir = join(root, "agent");
  const settingsManager = SettingsManager.inMemory({ enableSkillCommands: true });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [packageDir],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  return { root, agentDir, referenceDir, loader, settingsManager };
}

it("discovers packaged reference skills without offering them in the passive prompt", async () => {
  const { loader, referenceDir } = await loadPackageSkills();
  const { skills, diagnostics } = loader.getSkills();
  expect(diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
  const references = skills.filter((skill) => skill.baseDir === referenceDir);
  expect(references.map((skill) => skill.name).sort()).toEqual(referenceNames);
  const prompt = formatSkillsForPrompt(skills);
  expect(prompt).toContain("visible-control");
  for (const skill of references) {
    expect(prompt).not.toContain(skill.filePath);
    expect(prompt).not.toContain(`<name>${skill.name}</name>`);
  }
});

it("expands an explicitly invoked reference skill with user arguments", async () => {
  const { root, agentDir, referenceDir, loader, settingsManager } = await loadPackageSkills();
  const skillPath = join(referenceDir, "planning.md");
  const marker = "explicit-skill-content-control";
  writeFileSync(skillPath, `${readFileSync(skillPath, "utf8")}\n${marker}\n`);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(root, "models-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(root),
    modelRuntime,
    model: modelRuntime.getModel("anthropic", "claude-sonnet-4-5"),
    noTools: "all",
  });
  try {
    await session.steer("/skill:planning scope=release");
    const queued = session.getSteeringMessages();
    expect(queued).toHaveLength(1);
    const expanded = parseSkillBlock(queued[0]);
    expect(expanded?.name).toBe("planning");
    expect(expanded?.content).toContain(marker);
    expect(expanded?.userMessage).toBe("scope=release");
  } finally {
    session.dispose();
  }
});
