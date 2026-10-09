#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

const requiredDocuments = [
  "CHANGELOG.md",
  "README.md",
  "docs/extensions.md",
  "docs/sdk.md",
  "docs/usage.md",
  "docs/settings.md",
  "docs/packages.md",
  "docs/configuration.md",
  "docs/security.md",
  "docs/cli.md",
];

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !["--source-dir", "--old-version", "--new-version", "--output-dir"].includes(flag) ||
      !value ||
      value.startsWith("--")
    )
      fail("usage: --source-dir DIR --old-version X.Y.Z --new-version X.Y.Z --output-dir DIR");
    if (values[flag]) fail(`duplicate argument: ${flag}`);
    values[flag] = value;
  }
  if (Object.keys(values).length !== 4)
    fail("usage: --source-dir DIR --old-version X.Y.Z --new-version X.Y.Z --output-dir DIR");
  return {
    sourceDir: values["--source-dir"],
    oldVersion: values["--old-version"],
    newVersion: values["--new-version"],
    outputDir: values["--output-dir"],
  };
}

function version(value, name) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value))
    fail(`${name} must be an exact semantic version`);
  return value;
}

function safeDirectory(path, name) {
  if (!isAbsolute(path)) fail(`${name} must be absolute`);
  const resolved = resolve(path);
  if (dirname(resolved) === resolved) fail(`${name} must not be the filesystem root`);
  return resolved;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function headingRange(changelog, oldVersion, newVersion) {
  const headings = changelog.split(/\r?\n/).filter((line) => /^##\s+/.test(line));
  const match = (value) =>
    headings.findIndex((line) =>
      new RegExp(
        `^##\\s+(?:\\[)?${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\])?(?:\\s|$)`,
      ).test(line),
    );
  const newer = match(newVersion);
  const older = match(oldVersion);
  if (newer < 0 || older < 0)
    fail("CHANGELOG.md must contain exact level-two headings for both versions");
  if (newer > older) fail("new version heading must precede old version heading");
  return headings.slice(newer, older + 1);
}

let outputDir;
let ownsOutput = false;
try {
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = realpathSync(safeDirectory(args.sourceDir, "--source-dir"));
  outputDir = safeDirectory(args.outputDir, "--output-dir");
  const oldVersion = version(args.oldVersion, "--old-version");
  const newVersion = version(args.newVersion, "--new-version");
  if (oldVersion === newVersion) fail("versions must differ");
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory())
    fail("--source-dir must be an existing directory");
  if (existsSync(outputDir)) fail("--output-dir already exists");
  const resolvedOutput = resolve(realpathSync(dirname(outputDir)), basename(outputDir));
  if (
    resolvedOutput === sourceDir ||
    resolvedOutput.startsWith(`${sourceDir}${sep}`) ||
    sourceDir.startsWith(`${resolvedOutput}${sep}`)
  )
    fail("source and output directories must not contain each other");
  outputDir = resolvedOutput;

  const documentRoot = existsSync(resolve(sourceDir, "packages/coding-agent/package.json"))
    ? resolve(sourceDir, "packages/coding-agent")
    : sourceDir;
  const packageJsonPath = resolve(documentRoot, "package.json");
  if (!existsSync(packageJsonPath)) fail("source package.json is required");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.version !== newVersion)
    fail(`source package.json version must equal ${newVersion}`);

  const documents = requiredDocuments.map((path) => {
    const sourcePath = resolve(documentRoot, path);
    if (
      !sourcePath.startsWith(`${documentRoot}${sep}`) ||
      !existsSync(sourcePath) ||
      !lstatSync(sourcePath).isFile()
    )
      fail(`required document is missing: ${path}`);
    return { path, content: readFileSync(sourcePath, "utf8") };
  });
  const changelog = documents.find((document) => document.path === "CHANGELOG.md").content;
  const headings = headingRange(changelog, oldVersion, newVersion);

  mkdirSync(outputDir, { recursive: false });
  ownsOutput = true;
  for (const document of documents) {
    const destination = resolve(outputDir, document.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, document.content);
  }
  const metadata = {
    source: {
      path: sourceDir,
      packageName: packageJson.name ?? null,
      version: packageJson.version,
      packageJsonSha256: sha256(readFileSync(packageJsonPath)),
      documents: Object.fromEntries(
        documents.map((document) => [document.path, sha256(document.content)]),
      ),
    },
    versions: { old: oldVersion, new: newVersion },
    changelogRangeHeadings: headings,
  };
  writeFileSync(resolve(outputDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  writeFileSync(
    resolve(outputDir, "evidence.md"),
    `# Pi release evidence\n\nSource: ${sourceDir}\n\nOld version: ${oldVersion}\nNew version: ${newVersion}\n\n## Changelog range headings\n\n${headings.map((heading) => `- ${heading}`).join("\n")}\n`,
  );
  console.log(`Collected Pi release evidence in ${outputDir}`);
} catch (error) {
  if (ownsOutput && outputDir && existsSync(outputDir)) {
    try {
      rmSync(outputDir, { recursive: true, force: true });
    } catch {}
  }
  console.error(
    `collect-release-evidence failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
