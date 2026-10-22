// A real, low-memory workload for the supervisor's lease and signal lifecycle.
process.stdin.once("data", () => process.exit(7));
process.stdout.write("ready\n");
