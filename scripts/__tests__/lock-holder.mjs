import { acquireHeavyweightLock } from "../heavyweight-lock.mjs";

const lease = await acquireHeavyweightLock({ commonDir: process.argv[2] });
console.log("locked");
if (process.argv[3] === "--hold") process.stdin.resume();
else
  setTimeout(() => {
    void lease.release();
  }, 300);
