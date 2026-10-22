import { writeFileSync } from "node:fs";

// Publish the owned process group so failed tests can clean it without the supervisor.
writeFileSync(`${process.argv[2]}.parent`, `${process.pid}\n`);
writeFileSync(process.argv[2], `${process.pid}\n`);
process.stdin.once("data", () => process.exit(7));
process.stdout.write("ready\n");
