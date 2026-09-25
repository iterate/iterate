// `iterate@latest` on npm is the SDK prd serves. After every prd deploy (deploy-os.yml) this publishes
// packages/iterate as the next patch after what npm has, so a project's `npm install iterate` types
// the very modules the platform links into its loaded workers. Deploys run one at a time
// (deploy-os.yml's concurrency group), so "npm's version plus one" never races itself.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { z } from "zod";

const packageDirectory = path.resolve(import.meta.dirname, "../../packages/iterate");

/** A plain `major.minor.patch`, and its rank for ordering (each part below a million). */
function parseVersion(version: string) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`not a plain major.minor.patch version: ${version}`);
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return { major, minor, patch, rank: major * 1e12 + minor * 1e6 + patch };
}

/** The version to publish: the next patch after npm's, unless package.json names a higher one (a
 *  deliberate minor or major bump in the repo), which is published as it is. */
export function nextVersion(published: string | undefined, declared: string): string {
  const wanted = parseVersion(declared);
  if (!published) return declared;
  const latest = parseVersion(published);
  if (wanted.rank > latest.rank) return declared;
  return `${latest.major}.${latest.minor}.${latest.patch + 1}`;
}

/** npm's `latest` for iterate, or nothing when the package has never been published. */
function publishedVersion(): string | undefined {
  const view = spawnSync("npm", ["view", "iterate", "version"], { encoding: "utf8" });
  if (view.status === 0) return view.stdout.trim() || undefined;
  if (view.stderr.includes("E404")) return undefined;
  throw new Error(`npm view iterate failed: ${view.stderr}`);
}

function publishIterate() {
  const token = process.env.NPM_TOKEN;
  if (!token) throw new Error("NPM_TOKEN is required (Doppler os/prd)");
  const { version: declared } = z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(path.join(packageDirectory, "package.json"), "utf8")));
  const version = nextVersion(publishedVersion(), declared);
  const userconfig = path.join(mkdtempSync(path.join(tmpdir(), "npm-")), ".npmrc");
  writeFileSync(userconfig, `//registry.npmjs.org/:_authToken=${token}\n`);
  const env = { ...process.env, npm_config_userconfig: userconfig };
  // The runner's checkout only: the repo's package.json keeps the version a person last chose.
  execFileSync("npm", ["version", version, "--no-git-tag-version"], { cwd: packageDirectory, env });
  // pnpm, not npm: it applies publishConfig's exports (dist/*.mjs) to the published manifest.
  execFileSync("pnpm", ["publish", "--no-git-checks", "--access", "public", "--tag", "latest"], {
    cwd: packageDirectory,
    env,
    stdio: "inherit",
  });
  console.log(`published iterate@${version}`);
}

if (isMainModule(import.meta.url)) publishIterate();
