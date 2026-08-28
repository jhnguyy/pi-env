import { describe, expect, it } from "vitest";
import { applyManagedSettingsTransforms, parseJsonRelaxedText } from "../managed-settings-core.mjs";

describe("managed settings core", () => {
  it.each([
    ["empty input", "  \n", {}],
    ["strict JSON", '{"theme":"x","enabled":true}', { theme: "x", enabled: true }],
    [
      "comments and an object trailing comma",
      '{ // keep\n "theme": "x", /* drop */ }',
      { theme: "x" },
    ],
    ["an array trailing comma", '{"extensions":["a",]}', { extensions: ["a"] }],
    [
      "comment markers inside strings",
      '{"note":"// not a comment /* still text */"}',
      { note: "// not a comment /* still text */" },
    ],
  ])("parses %s", (_name, input, expected) => {
    expect(parseJsonRelaxedText(input)).toEqual(expected);
  });

  it("preserves __proto__ as an own JSON data property", () => {
    const result = parseJsonRelaxedText('{"__proto__":{"polluted":true},"ok":1}');

    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.polluted).toBeUndefined();
    expect(result.ok).toBe(1);
  });

  it.each([
    "// comment only",
    '{"theme":}',
    '{"a":[1,,2]}',
    '{"a":1,,}',
    '{"a":"unterminated}',
    '{"a": /* unterminated comment }',
  ])("rejects malformed input: %s", (input) => {
    expect(() => parseJsonRelaxedText(input)).toThrow(SyntaxError);
  });

  it("merges managed settings without comment keys through the aggregate transform", () => {
    expect(
      applyManagedSettingsTransforms(
        { nested: { keep: true } },
        { _comment: "ignored", nested: { add: 1 } },
        "/repo",
        "/repo",
      ),
    ).toMatchObject({
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
  });
});
