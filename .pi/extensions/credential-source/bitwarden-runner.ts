import { spawn } from "node:child_process";

function minimalEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "SYSTEMROOT",
    "TMPDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
  ] as const;
  return Object.fromEntries(
    allowed.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])),
  );
}

const [executable, field, itemId] = process.argv.slice(2);
if (!executable || field !== "password" || !/^[0-9a-f-]{36}$/i.test(itemId ?? "")) {
  process.exit(64);
}

let session = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  session += chunk;
  if (session.length > 16 * 1024) process.exit(65);
});
process.stdin.on("end", () => {
  session = session.replace(/[\r\n]+$/, "");
  if (!session) process.exit(65);

  const child = spawn(executable, ["get", field, itemId, "--nointeraction"], {
    env: { ...minimalEnvironment(process.env), BW_SESSION: session },
    stdio: ["ignore", "inherit", "inherit"],
  });
  session = "";
  child.once("error", () => process.exit(127));
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
});
