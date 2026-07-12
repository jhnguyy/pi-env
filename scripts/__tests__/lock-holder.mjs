import { acquireHeavyweightLock } from "../heavyweight-lock.mjs";

const lease = await acquireHeavyweightLock({ commonDir: process.argv[2] });
console.log("locked");
setTimeout(() => { void lease.release(); }, 300);
