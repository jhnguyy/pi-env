import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { testCleanup } from "./cleanup";
import { describe, expect, it } from "vitest";

import {
  loadSubagentRuntimeConfig,
  resolveSubagentRuntimeConfig,
  SubagentSessionStorage,
  SubagentSettingsSchema,
} from "../config";

describe("subagent session storage configuration", () => {
  it("loads an explicit agent directory while retaining project precedence and baseline fields", () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-config-"));
    testCleanup()(() => rmSync(root, { recursive: true, force: true }));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        subagent: { maxRunMs: 400, maxResultBytes: 100, sessionStorage: "sibling" },
      }),
    );
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ subagent: { maxRunMs: 200 } }),
    );
    expect(loadSubagentRuntimeConfig(cwd, agentDir)).toMatchObject({
      maxRunMs: 200,
      maxResultBytes: 100,
      sessionStorage: "sibling",
    });
  });

  it("defaults to nested child storage", () => {
    expect(resolveSubagentRuntimeConfig({}).sessionStorage).toBe(SubagentSessionStorage.Nested);
  });

  it("accepts sibling storage as a compatibility override", () => {
    const settings = Schema.decodeUnknownSync(SubagentSettingsSchema)({
      sessionStorage: "sibling",
    });

    expect(resolveSubagentRuntimeConfig(settings).sessionStorage).toBe(
      SubagentSessionStorage.Sibling,
    );
  });
});
