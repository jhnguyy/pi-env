import { describe, expect, it } from "vitest";
import {
  applyManagedSettingsTransforms,
  mergeManaged,
  parseJsonRelaxedText,
  renderSettings,
} from "../managed-settings-core.mjs";

describe("managed settings core", () => {
  it("parses comments and trailing commas", () => {
    expect(parseJsonRelaxedText('{ // keep\n "theme": "x", /* drop */ }')).toEqual({ theme: "x" });
  });

  it("merges managed settings without comment keys", () => {
    expect(
      mergeManaged({ nested: { keep: true } }, { _comment: "ignored", nested: { add: 1 } }),
    ).toEqual({
      nested: { keep: true, add: 1 },
    });
  });

  it("applies deterministic defaults and package registration", () => {
    const settings = applyManagedSettingsTransforms(
      { npmCommand: ["npm"], extensions: ["foo", "playwright-client"], packages: ["/worktree"] },
      { model: "managed" },
      "/worktree",
      "/primary",
    );

    expect(settings).toMatchObject({
      model: "managed",
      theme: "gruvbox-light/gruvbox-dark",
      npmCommand: ["nub"],
      piUpdate: { enabled: false },
      extensions: ["foo", "-playwright-client", "-work-tracker"],
      packages: ["/primary"],
    });
    expect(renderSettings(settings)).toBe(`${JSON.stringify(settings, null, 2)}\n`);
  });
});
