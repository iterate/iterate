import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..", "..");

process.env.ITERATE_REPO_DIR ??= repoRoot;
process.env.ITERATE_AUTO_INSTALL ??= "0";

// @ts-expect-error internal package entrypoint has no .d.ts
await import("../../packages/iterate/bin/iterate.js");
