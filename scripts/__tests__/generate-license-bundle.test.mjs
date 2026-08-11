import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateLicenseBundle,
  parseApkInstalled,
} from "../generate-license-bundle.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "pi-env-license-bundle-"));
  temporaryDirectories.push(path);
  return path;
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function packageRoot(repoRoot, virtualId, name) {
  const parts = name.startsWith("@") ? name.split("/") : [name];
  return join(repoRoot, "node_modules", ".nub", virtualId, "node_modules", ...parts);
}

function addPackage(repoRoot, {
  name,
  version = "1.0.0",
  license = "MIT",
  repository = "https://example.test/project",
  files = { LICENSE: "license text\n" },
  virtualId = `${name.replaceAll("/", "+")}@${version}`,
}) {
  const root = packageRoot(repoRoot, virtualId, name);
  mkdirSync(root, { recursive: true });
  const manifest = { name, version, repository };
  if (license !== undefined) manifest.license = license;
  write(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [file, content] of Object.entries(files)) write(join(root, file), content);
  return root;
}

function writePolicy(repoRoot, overrides = [], sourceRepositories = []) {
  const path = join(repoRoot, "policy.json");
  write(path, `${JSON.stringify({
    allowedLicenseIds: ["Apache-2.0", "MIT", "MPL-2.0"],
    prohibitedLicensePrefixes: ["AGPL-", "GPL-", "SSPL-"],
    sourceRequiredLicenseIds: ["MPL-2.0"],
    overrides,
    sourceRepositories,
  }, null, 2)}\n`);
  return path;
}

function generate(repoRoot, policyPath = writePolicy(repoRoot), outputName = "licenses") {
  return generateLicenseBundle({
    repoRoot,
    nodeModulesPath: join(repoRoot, "node_modules"),
    outputPath: join(repoRoot, outputName),
    policyPath,
  });
}

function fileTree(root) {
  const files = new Map();
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else files.set(relative(root, child), readFileSync(child, "utf8"));
    }
  }
  visit(root);
  return files;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("license bundle generation", () => {
  it("uses the installed Nub package tree instead of declared dependencies", () => {
    const repoRoot = temporaryDirectory();
    write(join(repoRoot, "package.json"), `${JSON.stringify({
      dependencies: { "declared-only": "1.0.0" },
    })}\n`);
    addPackage(repoRoot, { name: "installed-package" });

    const result = generate(repoRoot);

    expect(result.javascriptPackages.map((pkg) => pkg.name)).toEqual(["installed-package"]);
  });

  it("discovers scoped and unscoped symlinks in an additional package tree", () => {
    const repoRoot = temporaryDirectory();
    addPackage(repoRoot, { name: "project-package" });
    const globalRoot = join(repoRoot, "global-node-modules");
    const unscopedTarget = join(repoRoot, "global-store", "global-package");
    const scopedTarget = join(repoRoot, "global-store", "scoped-package");
    for (const [target, name] of [
      [unscopedTarget, "global-package"],
      [scopedTarget, "@global/scoped-package"],
    ]) {
      write(join(target, "package.json"), `${JSON.stringify({
        name,
        version: "1.0.0",
        license: "MIT",
        repository: `https://example.test/${name}`,
      })}\n`);
      write(join(target, "LICENSE"), `${name} license\n`);
    }
    mkdirSync(join(globalRoot, "@global"), { recursive: true });
    symlinkSync(unscopedTarget, join(globalRoot, "global-package"), "dir");
    symlinkSync(scopedTarget, join(globalRoot, "@global", "scoped-package"), "dir");

    const result = generateLicenseBundle({
      repoRoot,
      nodeModulesPath: join(repoRoot, "node_modules"),
      packageRoots: [globalRoot],
      outputPath: join(repoRoot, "licenses"),
      policyPath: writePolicy(repoRoot),
    });

    expect(result.javascriptPackages.map((pkg) => pkg.name)).toEqual([
      "@global/scoped-package",
      "global-package",
      "project-package",
    ]);
  });

  it("creates deterministic output for equivalent installed trees", () => {
    const first = temporaryDirectory();
    const second = temporaryDirectory();
    addPackage(first, { name: "alpha", files: { NOTICE: "notice\n", LICENSE: "license\n" } });
    addPackage(first, { name: "beta" });
    addPackage(second, { name: "beta" });
    addPackage(second, { name: "alpha", files: { LICENSE: "license\n", NOTICE: "notice\n" } });

    generate(first);
    generate(second);

    expect(fileTree(join(first, "licenses"))).toEqual(fileTree(join(second, "licenses")));
  });

  it("copies package license and third-party notice files", () => {
    const repoRoot = temporaryDirectory();
    addPackage(repoRoot, {
      name: "noticed-package",
      files: {
        LICENSE: "license text\n",
        "ThirdPartyNoticeText.txt": "third-party notice\n",
      },
    });

    const result = generate(repoRoot);
    const [record] = result.javascriptPackages;
    const outputDirectory = join(repoRoot, "licenses", "packages");
    const packageDirectory = readdirSync(outputDirectory)[0];

    expect(record.files).toEqual(["LICENSE", "ThirdPartyNoticeText.txt"]);
    expect(readFileSync(join(outputDirectory, packageDirectory, "LICENSE"), "utf8"))
      .toBe("license text\n");
    expect(readFileSync(join(outputDirectory, packageDirectory, "ThirdPartyNoticeText.txt"), "utf8"))
      .toBe("third-party notice\n");
  });

  it("uses a same-version, same-repository package as the license source", () => {
    const repoRoot = temporaryDirectory();
    addPackage(repoRoot, {
      name: "project-core",
      repository: "git+https://example.test/project.git",
      files: { LICENSE: "shared project license\n" },
    });
    addPackage(repoRoot, {
      name: "@project/linux-x64",
      repository: "https://example.test/project",
      files: {},
    });

    const result = generate(repoRoot);
    const platform = result.javascriptPackages.find((pkg) => pkg.name === "@project/linux-x64");

    expect(platform.upstreamLicenseTextMissing).toBe(true);
    expect(platform.licenseSource).toEqual({
      type: "repository-package",
      package: "project-core@1.0.0",
    });
  });

  it("does not borrow same-repository license text from a different version", () => {
    const repoRoot = temporaryDirectory();
    addPackage(repoRoot, {
      name: "project-core",
      version: "1.0.0",
      files: { LICENSE: "old project license\n" },
    });
    addPackage(repoRoot, {
      name: "project-platform",
      version: "2.0.0",
      files: {},
    });

    expect(() => generate(repoRoot)).toThrow(
      "project-platform@2.0.0: no license text or reviewed override is available",
    );
  });

  it("uses only a reviewed override when an installed package omits license text", () => {
    const repoRoot = temporaryDirectory();
    const overrideFile = join(repoRoot, "reviewed-MIT.txt");
    write(overrideFile, "reviewed license notice\n");
    addPackage(repoRoot, {
      name: "metadata-only",
      repository: "https://example.test/metadata-only",
      files: {},
    });
    const policyPath = writePolicy(repoRoot, [{
      repository: "https://example.test/metadata-only",
      license: "MIT",
      versions: ["1.0.0"],
      file: "reviewed-MIT.txt",
    }]);

    const result = generate(repoRoot, policyPath);
    const [record] = result.javascriptPackages;
    const notices = readFileSync(join(repoRoot, "licenses", "THIRD_PARTY_NOTICES.md"), "utf8");

    expect(record.upstreamLicenseTextMissing).toBe(true);
    expect(record.licenseSource.type).toBe("reviewed-override");
    expect(notices).toContain("metadata-only@1.0.0");
  });

  it("rejects a package without license text or a reviewed override", () => {
    const repoRoot = temporaryDirectory();
    addPackage(repoRoot, { name: "unresolved-package", files: {} });

    expect(() => generate(repoRoot)).toThrow(
      "unresolved-package@1.0.0: no license text or reviewed override is available",
    );
  });

  it("rejects missing license metadata", () => {
    const repoRoot = temporaryDirectory();
    addPackage(repoRoot, { name: "missing-metadata", license: null });

    expect(() => generate(repoRoot)).toThrow(
      "missing-metadata@1.0.0: package license metadata is missing",
    );
  });

  it("rejects a prohibited license in a composite expression", () => {
    const repoRoot = temporaryDirectory();
    addPackage(repoRoot, { name: "copyleft-package", license: "MIT OR GPL-3.0-only" });

    expect(() => generate(repoRoot)).toThrow(
      "copyleft-package@1.0.0: prohibited license: GPL-3.0-only",
    );
  });

  it("accepts an approved composite license expression without changing it", () => {
    const repoRoot = temporaryDirectory();
    addPackage(repoRoot, { name: "dual-package", license: "MIT OR Apache-2.0" });

    const result = generate(repoRoot);

    expect(result.javascriptPackages[0].license).toBe("MIT OR Apache-2.0");
  });

  it("requires an exact source reference for an executable-form license", () => {
    const repoRoot = temporaryDirectory();
    addPackage(repoRoot, {
      name: "source-required",
      license: "MPL-2.0",
      repository: "https://example.test/source-required",
    });

    expect(() => generate(repoRoot)).toThrow(
      "source-required@1.0.0: exact source reference is required for MPL-2.0",
    );
  });

  it("records an exact source reference for an executable-form license", () => {
    const repoRoot = temporaryDirectory();
    addPackage(repoRoot, {
      name: "source-required",
      license: "MPL-2.0",
      repository: "https://example.test/source-required",
    });
    const policyPath = writePolicy(repoRoot, [], [{
      repository: "https://example.test/source-required",
      versions: ["1.0.0"],
      reference: "https://example.test/source-required/tree/v{version}",
    }]);

    generate(repoRoot, policyPath);

    expect(readFileSync(join(repoRoot, "licenses", "SOURCE_CODE.md"), "utf8"))
      .toContain("https://example.test/source-required/tree/v1.0.0");
  });
});

describe("Alpine package metadata", () => {
  it("preserves exact license and source fields from the installed package database", () => {
    const directory = temporaryDirectory();
    const database = join(directory, "installed");
    write(database, [
      "P:busybox",
      "V:1.37.0-r31",
      "L:GPL-2.0-only",
      "o:busybox",
      "c:c3ef5d10",
      "U:https://busybox.net/",
      "",
    ].join("\n"));

    expect(parseApkInstalled(database)).toEqual([{
      name: "busybox",
      version: "1.37.0-r31",
      license: "GPL-2.0-only",
      origin: "busybox",
      buildCommit: "c3ef5d10",
      buildRecipe: "https://gitlab.alpinelinux.org/alpine/aports/-/commit/c3ef5d10",
      homepage: "https://busybox.net/",
    }]);
  });
});
