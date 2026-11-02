import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const cli = fileURLToPath(new URL("../dev.mjs", import.meta.url));
const heading = "Global inputs not qualified by local test selection:";
const followup =
  "Run nub run verify:full in an environment with adequate capacity to qualify these inputs.";

test("lists exact unqualified global inputs and full-verification guidance only for a changed delta", async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(join(tmpdir(), "verification-global-inputs-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    });
  const list = () =>
    execFileSync(process.execPath, [cli, "verify", "--list", "--checks-only", "--base", "main"], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    });

  git("init", "-b", "main");
  await writeFile(join(root, "package.json"), "{}\n");
  await writeFile(join(root, "vitest.config.ts"), "export default {};\n");
  git("add", ".");
  git("commit", "-m", "baseline");

  const empty = list();
  expect(empty).toContain("Verification scope: 0 changed paths");
  expect(empty).not.toContain(heading);
  expect(empty).not.toContain(followup);

  await writeFile(join(root, "package.json"), '{"private":true}\n');
  await writeFile(join(root, "vitest.config.ts"), "export default { test: {} };\n");

  const changed = list();
  expect(changed).toContain("Verification scope: 2 changed paths");
  expect(changed).toContain(`${heading}\n  package.json\n  vitest.config.ts\n${followup}\n`);
});
