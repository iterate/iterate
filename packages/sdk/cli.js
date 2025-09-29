/* eslint-disable no-console -- meh */
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
  // Capture output instead of inheriting stdio to filter out non-JSON
  const result = spawnSync("pnpx", ["--silent", "tsx", "--eval", code], {
    stdio: ["inherit", "pipe", "pipe"], // stdin inherited, stdout/stderr piped
    cwd: process.cwd(),
    encoding: "utf8",
  });

  if (result.error) {
    console.error("Failed to execute:", result.error);
    process.exit(1);
  }

  // Extract JSON from stdout, handling any extraneous output
  const stdout = result.stdout || "";

  // Try to find and extract valid JSON from the output
  // This handles cases where there might be debug logs or other output mixed in
  try {
    // Look for the last complete JSON object in the output
    // This works because our code outputs a single JSON.stringify at the end
    const jsonMatch = stdout.match(/\{[\s\S]*\}(?![\s\S]*\{)/);

    if (jsonMatch) {
      // Parse and re-stringify to ensure it's valid JSON
      const config = JSON.parse(jsonMatch[0]);
      console.log(JSON.stringify(config, null, 2));
    } else {
      // If no JSON found, output the raw stdout for debugging
      console.error("Warning: No valid JSON found in output");
      console.log(stdout);
    }
  } catch (error) {
    // If JSON parsing fails, output what we got for debugging
    console.error(
      "Warning: Failed to parse JSON from output:",
      error instanceof Error ? error.message : String(error),
    );
    console.log(stdout);
  }

  // Pass through stderr for debugging
  if (result.stderr) {
    console.error(result.stderr);
  }

  process.exit(result.status ?? 0);
}

main();
