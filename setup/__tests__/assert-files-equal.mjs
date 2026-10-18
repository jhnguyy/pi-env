import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [actualPath, expectedPath] = process.argv.slice(2);
assert.ok(
  readFileSync(actualPath).equals(readFileSync(expectedPath)),
  `File contents differ: ${actualPath}, ${expectedPath}`,
);
