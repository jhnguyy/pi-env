#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";

const [report, ...scripts] = process.argv.slice(2);
const results = [];
let reportFailed = false;
const diagnosticLimit = 4096;
const xml = (value) =>
  String(value)
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

function save() {
  try {
    const cases = results.map(({ script, status, seconds, diagnostics }) => {
      const message = `${script} exited with status ${status}; see the test:setup step log.`;
      const failure = status
        ? `<failure message="${xml(message)}">${xml(`${message}\n${diagnostics}`)}</failure>`
        : "";
      return `  <testcase classname="setup" name="${xml(script)}" time="${seconds.toFixed(3)}">${failure}</testcase>`;
    });
    const document = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<testsuite name="setup" tests="${results.length}" failures="${results.filter(({ status }) => status !== 0).length}" time="${results.reduce((sum, result) => sum + result.seconds, 0).toFixed(3)}">`,
      ...cases,
      "</testsuite>\n",
    ].join("\n");
    mkdirSync(dirname(report), { recursive: true });
    const temporary = `${report}.${process.pid}.tmp`;
    writeFileSync(temporary, document);
    renameSync(temporary, report);
  } catch {
    // Do not echo filesystem errors: paths and other ambient data are not evidence.
    console.error("setup-test: could not write JUnit report; see the test:setup step log.");
    reportFailed = true;
  }
}

async function run(script) {
  let diagnostics = "";
  let truncated = false;
  const retain = (line) => {
    if (!line.startsWith("FAIL:")) return;
    const remaining = diagnosticLimit - diagnostics.length;
    diagnostics += `${line}\n`.slice(0, remaining);
    if (line.length + 1 > remaining) truncated = true;
  };
  // Bound even unterminated output lines. Only explicit helper failures enter JUnit;
  // neither raw stream is persisted, and both still reach their original console.
  const forward = (stream, destination) => {
    let line = "";
    let clipped = false;
    const decoder = new StringDecoder("utf8");
    stream.on("data", (chunk) => {
      destination.write(chunk);
      for (const part of decoder.write(chunk).split(/(?<=\n)/)) {
        const text = part.endsWith("\n") ? part.slice(0, -1) : part;
        const remaining = diagnosticLimit - line.length;
        line += text.slice(0, remaining);
        clipped ||= text.length > remaining;
        if (part.endsWith("\n")) {
          if (line.startsWith("FAIL:") && clipped) truncated = true;
          retain(line);
          line = "";
          clipped = false;
        }
      }
    });
    stream.on("end", () => {
      const tail = decoder.end();
      if (line.length + tail.length > diagnosticLimit) clipped = true;
      line += tail.slice(0, diagnosticLimit - line.length);
      if (line.startsWith("FAIL:") && clipped) truncated = true;
      retain(line);
    });
  };
  console.log(`\nsetup-test: start ${script}`);
  const start = performance.now();
  const child = spawn("bash", [script], { stdio: ["inherit", "pipe", "pipe"] });
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  const status = await new Promise((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (code, signal) => resolve(code ?? 128 + (constants.signals[signal] ?? 0)));
  });
  const seconds = (performance.now() - start) / 1000;
  console.log(`setup-test: end ${script} status=${status} elapsed=${Math.floor(seconds)}s`);
  results.push({
    script,
    status,
    seconds,
    diagnostics: diagnostics + (truncated ? "\n[FAIL diagnostics truncated]" : ""),
  });
  save();
  return status;
}

save();
for (const script of scripts) {
  const status = await run(script);
  if (status !== 0) {
    process.exitCode = status;
    break;
  }
}
process.exitCode ||= reportFailed ? 1 : 0;
