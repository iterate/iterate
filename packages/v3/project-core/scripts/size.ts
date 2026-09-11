import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const totals = { implementation: 0, e2e: 0 };
async function count(directory: string, category: keyof typeof totals = "implementation") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".wrangler", ".git", "notes", "evidence"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await count(path, entry.name === "e2e" ? "e2e" : category);
    else if (/\.(ts|tsx|js|mjs|css|html|jsonc?)$/.test(entry.name)) {
      const content = await readFile(path, "utf8");
      const lines = content.split("\n").length - Number(content.endsWith("\n"));
      totals[category] += lines;
      console.log(`${String(lines).padStart(5)} ${path}`);
    }
  }
}
await count(new URL("..", import.meta.url).pathname);
console.log(`${totals.implementation} raw implementation lines; limit <5000`);
console.log(`${totals.e2e} raw E2E lines; reported separately, not budgeted`);
console.log(
  `${totals.implementation + totals.e2e} raw authored lines under the historical stricter all-authored measure`,
);
if (totals.implementation >= 5000) process.exitCode = 1;
