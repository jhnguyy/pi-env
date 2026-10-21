import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {});
writeFileSync(process.argv[2], `${process.pid}\n`);
setInterval(() => {}, 1_000);
