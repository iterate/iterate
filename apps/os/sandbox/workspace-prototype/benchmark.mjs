// Manual acceptance benchmark, run after the proof has warmed npm's package cache.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const sourceReads = [];
for (let pass = 0; pass < 2; pass++) {
  const start = performance.now();
  for (let index = 0; index < 100; index++) readFileSync(`unread/${index}.txt`);
  sourceReads.push(performance.now() - start);
}
const parallelStart = performance.now();
await Promise.all(Array.from({ length: 100 }, (_, index) => readFile(`unread/${index + 100}.txt`)));
const parallelColdReadMs = performance.now() - parallelStart;
const native = mkdtempSync("/tmp/workspace-native-benchmark-");
writeFileSync(`${native}/package.json`, readFileSync("package.json"));
mkdirSync(`${native}/node_modules`);
const installs = [];
for (const cwd of [native, process.cwd(), process.cwd(), native]) {
  for (const name of readdirSync(`${cwd}/node_modules`)) {
    rmSync(`${cwd}/node_modules/${name}`, { recursive: true, force: true });
  }
  const start = performance.now();
  const result = spawnSync(
    "npm",
    ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "npm failed");
  installs.push({ native: cwd === native, milliseconds: performance.now() - start });
}
console.info(
  JSON.stringify({
    benchmark: {
      sourceReadCount: 100,
      coldReadMs: sourceReads[0],
      warmReadMs: sourceReads[1],
      parallelColdReadMs,
      installs,
    },
  }),
);
rmSync(native, { recursive: true });
