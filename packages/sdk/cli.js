// this is the most embryonic form of the iterate cli
// the main purpose is to make it possible to run
// `pnpm iterate iterate.config.ts` and get JSON stringified output

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function main() {
  const args = process.argv.slice(2);
  const inputPath = args[0] ?? "iterate.config.ts";
  const absolutePath = resolve(process.cwd(), inputPath);
  const fileUrl = pathToFileURL(absolutePath).href;

  const code = `import(${JSON.stringify(fileUrl)}).then(m => console.log(JSON.stringify(m.default, null, 2)));`;

  // Run node synchronously with module eval and TS stripping
  const result = spawnSync("pnpx", ["--silent", "tsx", "--eval", code], {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  process.exit(result.status ?? 0);
}

main();
