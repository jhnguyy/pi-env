import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { piTui } from "./fixtures/pi-tui";

const test = process.env["E2E"] === "1" ? it : it.skip;
const extension = join(process.cwd(), ".pi/extensions/share/dist/index.js");
const override = join(process.cwd(), ".pi/extensions/share/__tests__/fixtures/command-override.ts");
const second = join(process.cwd(), ".pi/extensions/share/__tests__/fixtures/second-command-override.ts");
const ordinary = join(process.cwd(), ".pi/extensions/share/__tests__/fixtures/ordinary-command.ts");
const replacementEditor = join(process.cwd(), ".pi/extensions/share/__tests__/fixtures/replacement-editor.ts");

test.each([
  { command: "/share", replacement: false },
  { command: "/share-private", replacement: false },
  { command: "/share", replacement: true },
])("$command opens the private prompt (replacement editor=$replacement)", async ({ command, replacement }) => {
  const f = piTui(replacement ? [extension, replacementEditor] : [extension]);
  await f.waitFor("No models available");
  f.send(command);
  expect(await f.waitFor("Private GitHub repository")).toContain("saved as your default");
  f.escape();
  expect(JSON.parse(readFileSync(f.settings, "utf8"))).not.toHaveProperty("share");
  expect(f.ghCalls()).toBe("");
  f.passed();
});

test("a claimed handler failure cannot fall through to native sharing", async () => {
  const f = piTui([override], ["--override-test-mode", "error"]);
  await f.waitFor("No models available");
  f.send("/share");
  await f.waitFor("Synthetic override failure");
  expect(f.ghCalls()).toBe("");
  f.passed();
});

test("canceling a claimed confirmation consumes the command and its arguments", async () => {
  const f = piTui([override], ["--override-test-mode", "confirm"]);
  await f.waitFor("No models available");
  f.send("/share from-terminal");
  await f.waitFor("Synthetic override confirmation");
  f.escape();
  const screen = await f.waitFor("Override handled without upload");
  expect(screen).toContain("Override handled without upload: from-terminal");
  expect(f.ghCalls()).toBe("");
  f.passed();
});

test("multiple explicit claimants block the bare command rather than restore native sharing", async () => {
  const f = piTui([override, second]);
  await f.waitFor("No models available");
  f.send("/share");
  const screen = await f.waitFor('Extension "command:share" error:');
  expect(screen).toContain("override conflict");
  expect(screen).not.toContain("Override handled without upload");
  expect(f.ghCalls()).toBe("");
  f.passed();
});

test.each([{ extensions: [] }, { extensions: [ordinary] }])("native sharing remains unchanged without an explicit claim ($extensions)", async ({ extensions }) => {
  const f = piTui(extensions);
  await f.waitFor("No models available");
  f.send("/share");
  const screen = await f.waitFor("GitHub CLI is not logged in");
  expect(screen).not.toContain("An ordinary handler must not run");
  expect(f.ghCalls()).toContain("auth status");
  expect(f.ghCalls()).not.toContain("gist create");
  f.passed();
});
