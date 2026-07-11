#!/usr/bin/env node
import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { build } from "esbuild";
import type { BundleWorkerRequest } from "../src/analyze/external/bundle-protocol.js";

async function readStdin(maxBytes = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  // analyze: allow-sequential
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error(`bundle request exceeded ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

try {
  const request = JSON.parse(await readStdin()) as Partial<BundleWorkerRequest>;
  if (request.version !== 1 || typeof request.cwd !== "string" || typeof request.entryPoint !== "string" || !Array.isArray(request.externals) || !request.externals.every((value) => typeof value === "string") || typeof request.outputDirectory !== "string") {
    throw new Error("invalid version 1 bundle request");
  }
  const outputPrefix = `${resolve(tmpdir(), "pi-analyze-bundle-")}`;
  if (!/^\.pi\/extensions\/[^/]+\/index\.ts$/.test(request.entryPoint) || isAbsolute(request.entryPoint) || request.entryPoint.split(/[\\/]/).includes("..") || !isAbsolute(request.outputDirectory) || !request.outputDirectory.startsWith(outputPrefix) || request.outputDirectory.includes(`${sep}..${sep}`)) {
    throw new Error("bundle request contains an unsafe path");
  }
  const result = await build({ 
    absWorkingDir: request.cwd,
    entryPoints: [request.entryPoint],
    bundle: true,
    write: true,
    metafile: true,
    outdir: request.outputDirectory,
    platform: "node",
    format: "esm",
    external: [...request.externals],
    logLevel: "silent",
  });
  process.stdout.write(JSON.stringify({ version: 1, ok: true, metafile: result.metafile }));
} catch (cause) {
  process.stderr.write(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
  process.exitCode = 1;
}
