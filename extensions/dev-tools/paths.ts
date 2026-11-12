import { isAbsolute, join } from "node:path";

export function daemonPaths(env: NodeJS.ProcessEnv = process.env) {
  const directory = env.PI_ENV_LSP_DIR?.trim() || "/tmp";
  if (!isAbsolute(directory)) throw new Error("PI_ENV_LSP_DIR must be an absolute directory");
  const base = join(directory, `pi-lsp-${process.getuid?.() ?? 1000}`);
  return { socketPath: `${base}.sock`, pidPath: `${base}.pid` };
}
