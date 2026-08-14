import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const rootPath = join(process.cwd(), "package.json");
const linearPath = join(process.cwd(), ".pi", "extensions", "linear", "package.json");
const credentialSourcePath = join(process.cwd(), ".pi", "extensions", "credential-source", "package.json");

const readPackageJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as PackageJson;

const exactSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

it("keeps root Effect family pins synchronized with Linear and Credential Source", async () => {
  const [root, linear, credentialSource] = await Promise.all([
    readPackageJson(rootPath),
    readPackageJson(linearPath),
    readPackageJson(credentialSourcePath),
  ]);

  const rootEffect = root.dependencies?.effect;
  expect(rootEffect).toMatch(exactSemver);
  expect(root.dependencies?.["@effect/platform-node"]).toBe(rootEffect);
  expect(root.dependencies?.["@effect/opentelemetry"]).toBe(rootEffect);
  expect(root.devDependencies?.["@effect/vitest"]).toBe(rootEffect);
  expect(linear.dependencies?.effect).toBe(rootEffect);
  expect(credentialSource.dependencies?.effect).toBe(rootEffect);
});
