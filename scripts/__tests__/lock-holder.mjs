import { acquireHeavyweightLock } from "../heavyweight-lock.mjs";

const lease = await acquireHeavyweightLock({ commonDir: process.argv[2] });
console.log("locked");
setTimeout(async () => { await lease.release(); }, 300);
