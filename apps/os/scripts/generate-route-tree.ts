// Regenerates src/routeTree.gen.ts outside of `vite dev`/`vite build`, using the
// same generator + config that @tanstack/react-start's vite plugin uses. This keeps
// the checked-in route tree honest: `--check` fails (without writing) when the file
// is stale, so CI catches route files added or renamed without regenerating.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Generator, getConfig } from "@tanstack/router-generator";

const checkOnly = process.argv.includes("--check");
const root = path.resolve(import.meta.dirname, "..");
const routeTreePath = path.resolve(root, "src/routeTree.gen.ts");

const config = getConfig(
  {
    routesDirectory: path.resolve(root, "src/routes"),
    generatedRouteTree: routeTreePath,
    target: "react",
  },
  root,
);

const before = readFileSync(routeTreePath, "utf8");
await new Generator({ config, root }).run();
const after = readFileSync(routeTreePath, "utf8");

if (before === after) {
  console.log("routeTree.gen.ts is up to date");
} else if (checkOnly) {
  writeFileSync(routeTreePath, before);
  console.error(
    "routeTree.gen.ts is stale. Run `pnpm --dir apps/os routes:generate` (or `pnpm dev`) and commit the result.",
  );
  process.exit(1);
} else {
  console.log("routeTree.gen.ts regenerated");
}
