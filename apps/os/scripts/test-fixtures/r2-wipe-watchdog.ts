import { spawn } from "node:child_process";
import { armR2WipeChildWatchdog } from "../r2-wipe-child.ts";

const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});

armR2WipeChildWatchdog();
process.send?.({ descendantPid: descendant.pid });
setInterval(() => {}, 1000);
