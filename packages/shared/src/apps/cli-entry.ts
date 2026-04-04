import process from "node:process";

import { runAppCli } from "./cli.ts";

try {
  await runAppCli();
} catch (error) {
  console.error(error);
  process.exit(1);
}
