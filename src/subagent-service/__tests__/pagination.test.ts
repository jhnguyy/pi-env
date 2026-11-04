import { expect, it } from "vitest";
import { pageText } from "../pagination.js";

it("defaults to 4096 UTF-16 units and marks a partial first page", () => {
  const text = "😀".repeat(2049);
  expect(pageText(text)).toEqual({
    text: "😀".repeat(2048),
    offset: 0,
    nextOffset: 4096,
    total: 4098,
    truncated: true,
  });
});

it("preserves UTF-16 slice boundaries, including a split surrogate pair", () => {
  expect(pageText("A😀B", { offset: 1, limit: 1 })).toEqual({
    text: "\ud83d",
    offset: 1,
    nextOffset: 2,
    total: 4,
    truncated: true,
  });
  expect(pageText("A😀B", { offset: 2, limit: 10 })).toEqual({
    text: "\ude00B",
    offset: 2,
    nextOffset: null,
    total: 4,
    truncated: true,
  });
});

it("clamps past-end offsets and distinguishes empty from omitted content", () => {
  expect(pageText("abc", { offset: Number.MAX_SAFE_INTEGER })).toEqual({
    text: "",
    offset: 3,
    nextOffset: null,
    total: 3,
    truncated: true,
  });
  expect(pageText("")).toEqual({
    text: "",
    offset: 0,
    nextOffset: null,
    total: 0,
    truncated: false,
  });
  expect(pageText("abc", { limit: 3 })).toEqual({
    text: "abc",
    offset: 0,
    nextOffset: null,
    total: 3,
    truncated: false,
  });
});
