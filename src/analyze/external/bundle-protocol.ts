import type { Metafile } from "esbuild";

export interface BundleWorkerRequest {
  version: 1;
  cwd: string;
  entryPoint: string;
  externals: readonly string[];
  outputDirectory: string;
}

export interface BundleWorkerResponse {
  version: 1;
  ok: true;
  metafile: Metafile;
}
