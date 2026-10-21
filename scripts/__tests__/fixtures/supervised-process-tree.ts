import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const groupFile = `${process.argv[2]}.parent`;
writeFileSync(`${groupFile}.tmp`, `${process.pid}\n`);
renameSync(`${groupFile}.tmp`, groupFile);
spawn(process.execPath, [join(import.meta.dirname, "supervised-descendant.ts"), process.argv[2]], {
  stdio: "ignore",
});
setInterval(() => {}, 1_000);
