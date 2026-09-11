/** Raw authored implementation LOC, including this counter. Generated bundles/declarations are
 * counted at their first-party sources, not twice; dependency implementations are third-party.
 * A passing count does not replace the public API, runtime and telemetry acceptance gates. */
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
// The 5 September landing budget is 15k total; a smaller tutorial spine is a separate
// structural claim and must never be manufactured by excluding implementation here.
const IMPLEMENTATION_BUDGET_LOC = 15_000;
const testOnly = new Set([
  "src/stream/test-support.ts",
  "src/stream/node-sqlite-durable-object-storage.ts",
  "src/stream/memory-budget-scenarios.ts",
  "src/context/expression-memory-scenario.ts",
]);
const authored = globSync(
  ["src/**/*.{ts,tsx,html}", "examples/**/*.{ts,tsx,js}", "scripts/*.ts", "build-*.mjs"],
  { cwd: root, exclude: ["src/generated/**"] },
);
const implementation = [
  ...authored.filter((path) => !path.endsWith(".test.ts") && !testOnly.has(path)),
  "package.json",
  "wrangler.jsonc",
  "wrangler.bundler.jsonc",
  "tsconfig.json",
  "tsconfig.client.json",
  "tsconfig.scripts.json",
];
const tests = globSync(
  ["e2e/**/*.{ts,tsx,js,json}", "__workers-tests__/**/*.{ts,tsx,js,json}", "src/**/*.test.ts"],
  { cwd: root },
);
const lines = (path: string) => {
  const text = readFileSync(resolve(root, path), "utf8");
  return text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
};
const total = (paths: string[]) =>
  [...new Set(paths)].reduce((count, path) => count + lines(path), 0);
const ownLines = total(implementation);
// The deploy generator imports the shared environment map. Report/count the entire authored
// map conservatively, including other app declarations and its data-only re-export.
const sharedLines = total(["../../../envs.ts", "../../v3/project-core/deployment.ts"]);
// Count our dependency work too. Conservatively count the complete source-file patch hunks,
// including context and removed lines; generated dist bundles repeat these authored changes.
const dependencyPatchLines = readFileSync(
  resolve(root, "../../../patches/json5@2.2.3.patch"),
  "utf8",
)
  .split(/(?=^diff --git )/m)
  .filter((section) => section.startsWith("diff --git a/lib/"))
  .reduce((count, section) => count + section.trimEnd().split("\n").length, 0);
const implementationLines = ownLines + sharedLines + dependencyPatchLines;
console.log(
  `${ownLines} package implementation lines; ${sharedLines} shared environment-map lines`,
);
console.log(`${dependencyPatchLines} conservatively counted authored dependency-patch lines`);
console.log(
  `${implementationLines} conservatively counted implementation lines; landing budget <=${IMPLEMENTATION_BUDGET_LOC}`,
);
console.log(
  `${total([...tests, ...testOnly])} test and test-helper lines (excluded from the limit)`,
);
if (process.argv.includes("--files"))
  for (const path of implementation.sort()) console.log(`${lines(path)}\t${path}`);
if (implementationLines > IMPLEMENTATION_BUDGET_LOC) process.exitCode = 1;
