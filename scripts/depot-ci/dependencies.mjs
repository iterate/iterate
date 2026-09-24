// Run with Node alone: dependency setup cannot depend on an installed npm package.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const started = performance.now();
const mode = process.argv[2];
if (!["install", "seal", "fingerprint"].includes(mode)) {
  throw new Error("Usage: node scripts/depot-ci/dependencies.mjs install|seal|fingerprint");
}
const root = realpathSync(process.cwd());
const stampPath = "node_modules/.iterate-baked-deps.json";
const repositoryFiles = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const files = repositoryFiles.filter(
  (file) =>
    /(^|\/)(package\.json|\.npmrc|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.?pnpmfile\.cjs)$/.test(
      file,
    ) ||
    file.startsWith("patches/") ||
    file === "scripts/depot-ci/bake-preview-ci-image.sh" ||
    file === ".depot/workflows/build-preview-ci-image.yml",
);
// Local file dependencies also depend on their source contents, unlike live
// workspace links. Include every visible file beneath those package paths.
for (const file of [...files].filter(
  (file) => /(^|\/)package\.json$/.test(file) && existsSync(file),
)) {
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  for (const specifier of Object.values({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  })) {
    if (!specifier.startsWith("file:")) continue;
    const dependency = relative(root, resolve(dirname(file), specifier.slice(5)));
    if (dependency.startsWith("../"))
      throw new Error(`Local dependency outside checkout: ${file} -> ${specifier}`);
    files.push(
      ...repositoryFiles.filter((path) => path === dependency || path.startsWith(`${dependency}/`)),
    );
  }
}
// A manifest's install inputs: what pnpm resolves, links or runs. Its other fields — `scripts` beyond
// the lifecycle hooks, `exports`, `main`, `types`, `files`, `description` — change node_modules not at
// all, and hashing them made every edit to a package's `test` script a 60 s reinstall in CI
// (2026-09-21: two PRs' preview jobs missed the baked dependencies over an added `e2e:soak` script).
const MANIFEST_INSTALL_FIELDS = [
  "name",
  "version",
  "private",
  "packageManager",
  "bin",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "dependenciesMeta",
  "bundledDependencies",
  "bundleDependencies",
  "overrides",
  "resolutions",
  "pnpm",
  "engines",
  "os",
  "cpu",
  "workspaces",
];
const LIFECYCLE_HOOKS = [
  "pnpm:devPreinstall",
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
];
function manifestInstallInputs(file) {
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const inputs = {};
  for (const field of MANIFEST_INSTALL_FIELDS)
    if (field in manifest) inputs[field] = manifest[field];
  const scripts = manifest.scripts ?? {};
  for (const hook of LIFECYCLE_HOOKS)
    if (hook in scripts) inputs[`scripts.${hook}`] = scripts[hook];
  return JSON.stringify(inputs);
}

const hash = createHash("sha256");
// Include this implementation, including the validity policy, even outside this repo (tests).
hash.update(readFileSync(new URL(import.meta.url)));
for (const file of [...new Set(files)].sort()) {
  const contents = !existsSync(file)
    ? null
    : /(^|\/)package\.json$/.test(file)
      ? manifestInstallInputs(file)
      : readFileSync(file).toString("base64");
  hash.update(JSON.stringify([file, contents]));
}
for (const file of [
  join(homedir(), ".npmrc"),
  join(dirname(dirname(process.execPath)), "etc/npmrc"),
]) {
  hash.update(
    JSON.stringify([file, existsSync(file) ? readFileSync(file).toString("base64") : null]),
  );
}
hash.update(
  JSON.stringify({
    root,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    environment: Object.entries(process.env)
      .filter(([key]) => /^(npm_config_|pnpm_config_)/i.test(key) || key === "NODE_ENV")
      .sort(),
  }),
);
const fingerprint = hash.digest("hex");
if (mode === "fingerprint") {
  console.log(fingerprint);
  process.exit(0);
}

// Only this CI lifecycle is safe to omit. New workspace hooks must run until their
// source inputs and generated outputs have an explicit reuse contract.
const safeLifecycle =
  process.env.CI === "true" &&
  files
    .filter((file) => /(^|\/)package\.json$/.test(file) && existsSync(file))
    .every((file) => {
      const { scripts = {} } = JSON.parse(readFileSync(file, "utf8"));
      return LIFECYCLE_HOOKS.every(
        (hook) =>
          !scripts[hook] ||
          (file === "package.json" && hook === "prepare" && scripts[hook] === "is-ci || husky"),
      );
    });

if (mode === "seal") {
  if (!safeLifecycle)
    throw new Error(
      "Cannot seal dependencies with unmodelled workspace lifecycle scripts or outside CI",
    );
  const { projects } = JSON.parse(
    readFileSync("node_modules/.pnpm-workspace-state-v1.json", "utf8"),
  );
  const directories = Object.keys(projects)
    .map((project) => join(project, "node_modules"))
    .filter((directory) => existsSync(directory));
  const state = installedState(directories);
  writeFileSync(stampPath, JSON.stringify({ fingerprint, directories, state }) + "\n");
  console.log(`[ci-deps] sealed ${fingerprint}`);
  if (process.env.GITHUB_OUTPUT)
    writeFileSync(process.env.GITHUB_OUTPUT, `fingerprint=${fingerprint}\n`, { flag: "a" });
  process.exit(0);
}

// What the fingerprint was computed WITH, on every outcome: the node the step ran (its version and
// path are inputs — a runner whose PATH puts another node first than the image's baked one computes
// a different fingerprint on identical sources; 2026-09-22 every job missed a stamp that jobs had hit
// the evening before) and the stamp it was compared against.
const environmentNote = `node=${process.version} at ${process.execPath}`;
let reason = "no baked fingerprint";
let stampNote = "no stamp";
if (existsSync(stampPath)) {
  try {
    const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
    stampNote = `stamp=${String(stamp.fingerprint).slice(0, 12)}`;
    reason = "dependency inputs changed";
    if (stamp.fingerprint === fingerprint) {
      reason = "workspace lifecycle requires install";
      if (safeLifecycle) {
        reason = "installed state changed";
        if (installedState(stamp.directories) === stamp.state) {
          console.log(
            `[ci-deps] reused baked dependencies ${fingerprint} in ${Math.round(performance.now() - started)}ms; ${environmentNote}`,
          );
          process.exit(0);
        }
      }
    }
  } catch (error) {
    if (!(error instanceof SyntaxError) && error.code !== "ENOENT" && error.code !== "ENOTDIR")
      throw error;
    reason = "baked state missing or unreadable";
  }
}
console.log(
  `[ci-deps] install required: ${reason}; fingerprint=${fingerprint}; ${stampNote}; ${environmentNote}`,
);
// A failed reconciliation must never leave an apparently valid stamp behind.
rmSync(stampPath, { force: true });
const install = spawnSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
  stdio: "inherit",
});
if (install.error) throw install.error;
process.exit(install.status === null ? 1 : install.status);

function installedState(directories) {
  const state = createHash("sha256");
  for (const file of [
    "node_modules/.modules.yaml",
    "node_modules/.pnpm/lock.yaml",
    "node_modules/.pnpm-workspace-state-v1.json",
  ]) {
    state.update(readFileSync(file));
  }
  for (const directory of directories) {
    state.update(
      JSON.stringify([
        realpathSync(directory),
        readdirSync(directory)
          .filter((entry) => entry !== ".iterate-baked-deps.json")
          .sort(),
      ]),
    );
  }
  return state.digest("hex");
}
