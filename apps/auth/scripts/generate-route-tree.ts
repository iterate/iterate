// Regenerates src/routeTree.gen.ts outside of `vite dev`/`vite build`, using the
// same generator + config that @tanstack/react-start's vite plugin uses (mirrors
// apps/os/scripts/generate-route-tree.ts). `--check` fails (and restores the
// original file) when the checked-in tree is stale, so CI catches route files
// added or renamed without regenerating.
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
    // Mirrors the router options in vite.config.ts.
    addExtensions: true,
    semicolons: true,
    quoteStyle: "double",
    // @tanstack/start-plugin-core appends this Register block when the vite
    // plugin runs the generator; mirror it so this script produces the same
    // output as the build. Source of the footer (pin bumps may change it):
    // https://github.com/TanStack/router/blob/main/packages/start-plugin-core/src/start-compiler-plugin/route-tree-footer.ts
    routeTreeFileFooter: [
      [
        'import type { getRouter } from "./router.tsx";',
        'import type { createStart } from "@tanstack/react-start";',
        'declare module "@tanstack/react-start" {',
        "  interface Register {",
        "    ssr: true;",
        "    router: Awaited<ReturnType<typeof getRouter>>;",
        "  }",
        "}",
      ].join("\n"),
    ],
  },
  root,
);

// Generator.run() writes the file in place. In check mode we always restore the
// original afterwards (even if run() throws) so a failed/interrupted check never
// leaves a mutated working tree that a later check would compare against.
const before = readFileSync(routeTreePath, "utf8");
let after = before;
try {
  await new Generator({ config, root }).run();
  after = readFileSync(routeTreePath, "utf8");
} finally {
  if (checkOnly) writeFileSync(routeTreePath, before);
}

if (before === after) {
  console.log("routeTree.gen.ts is up to date");
} else if (checkOnly) {
  console.error(
    "routeTree.gen.ts is stale. Run `pnpm --dir apps/auth routes:generate` (or `pnpm dev`) and commit the result.",
  );
  process.exit(1);
} else {
  console.log("routeTree.gen.ts regenerated");
}
