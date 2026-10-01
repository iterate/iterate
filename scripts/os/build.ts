// ROOT `pnpm os:build`: core/os's build (its generated modules, then `vite build`) with iterate's
// project templates (config-templates.ts), what the root `pnpm test` and test/'s suites run. A bare
// `pnpm --filter os build` bakes only core's minimal config.
import path from "node:path";
import { build } from "../../core/os/scripts/build.ts";
import { viteBuild } from "../../core/os/scripts/vite-build.ts";
import { configTemplates } from "./config-templates.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
await build({ templates: configTemplates(repoRoot) });
await viteBuild(path.join(repoRoot, "core/os"), {});
