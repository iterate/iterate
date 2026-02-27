/**
 * Postbuild script to copy the platform-specific node-pty binary to the Nitro build output.
 *
 * @lydell/node-pty uses optionalDependencies to provide pre-built binaries for each platform
 * (e.g. @lydell/node-pty-darwin-arm64). Nitro's dependency tracing doesn't follow optional
 * dependencies, so these binaries aren't copied to dist/server/node_modules during build.
 * This script runs after vite build to copy the correct binary for the current platform.
 */
import { cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const monorepoRoot = join(projectRoot, "..", "..");
const distNodeModules = join(projectRoot, "dist", "server", "node_modules");

const platform = process.platform;
const arch = process.arch;
const packageName = `@lydell/node-pty-${platform}-${arch}`;
const pnpmPackagePrefix = `@lydell+node-pty-${platform}-${arch}@`;

function findInPnpmStore() {
  const pnpmDir = join(monorepoRoot, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return null;

  const entries = readdirSync(pnpmDir);
  const match = entries.find((e) => e.startsWith(pnpmPackagePrefix));
  if (!match) return null;

  return join(pnpmDir, match, "node_modules", "@lydell", `node-pty-${platform}-${arch}`);
}

const possibleSourcePaths = [
  join(projectRoot, "node_modules", packageName),
  findInPnpmStore(),
].filter(Boolean);

let sourcePath = null;
for (const path of possibleSourcePaths) {
  if (existsSync(path)) {
    sourcePath = path;
    break;
  }
}

if (!sourcePath) {
  console.error(`Could not find ${packageName} in any of:`);
  possibleSourcePaths.forEach((p) => console.error(`  - ${p}`));
  process.exit(1);
}

const destPath = join(distNodeModules, "@lydell", `node-pty-${platform}-${arch}`);

console.log(`Copying ${packageName} from ${sourcePath} to ${destPath}`);
cpSync(sourcePath, destPath, { recursive: true });
console.log(`Successfully copied ${packageName}`);
