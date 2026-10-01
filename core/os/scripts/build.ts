// Prepare source consumed by the Worker build: the platform packages loaded workers import and the
// config templates it offers: core's own (core/configs), and any others this step is given
// (`--template`, or `build({ templates })` from iterate's deploy tooling). Vite builds the Worker
// and Start client after this step; Vitest runs that built Worker.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build as esbuild } from "esbuild";
import {
  formatConfigRepoTemplateReference,
  parseConfigRepoTemplateReference,
} from "iterate/config-repo-template";
import {
  downloadPublicGithubTemplate,
  pinPublicGithubTemplate,
} from "../src/repo/github-template.ts";
import { viteBuild } from "./vite-build.ts";
import type { OsDeployableEnv } from "./os-env.ts";

const root = path.resolve(import.meta.dirname, "..");

/** The packages a loaded worker imports from THIS deployment rather than from npm: every `iterate/*`
 *  subpath that runs in workerd, and the zod the SDK itself is built on (one zod per isolate, so a
 *  schema made by user code is the schema the SDK checks). `package.json` naming `iterate` as
 *  `latest` (or not at all) links against these — on a preview, the PR's own SDK. */
const PLATFORM_ENTRIES = [
  "iterate/sdk",
  "iterate/stream/processor",
  "iterate/stream/contract",
  "iterate/stream/run",
  "iterate/email",
  "iterate/api",
  "iterate/lib",
  "iterate/expression",
  "iterate/principal",
  "iterate/agents",
  "iterate/agents/install",
  "iterate/agents/contract",
  "iterate/agents/processor",
  "iterate/agents/codemode-format",
  "zod",
] as const;

/** The platform packages as loader modules: one split esbuild graph (shared code lands in chunks,
 *  so `iterate/sdk` and `iterate/stream/processor` share one zod and one kernel), each output under
 *  `node_modules/…` with the modules it imports — the resolver (context/module-resolution.ts) hands
 *  a loaded worker only what its imports reach. */
async function platformModules() {
  // Every entry is a re-export resolved from the SDK's own directory, exactly as the SDK's imports
  // are: `require.resolve("zod")` would pick zod's CJS build while the SDK links its ESM one — two
  // zods in one graph.
  const sdkDir = path.dirname(createRequire(import.meta.url).resolve("iterate/sdk"));
  const entryPoints = {
    ...Object.fromEntries(
      PLATFORM_ENTRIES.map((specifier) => [
        `node_modules/${specifier}`,
        `platform-entry:${specifier}`,
      ]),
    ),
    // what every loaded worker evaluates first (module-resolution.ts `enteredThroughPlatform`)
    "node_modules/.platform/loaded-worker": path.join(sdkDir, "loaded-worker.ts"),
  };
  const outdir = path.join(root, "src/generated/.platform-modules");
  const bundled = await esbuild({
    entryPoints,
    plugins: [
      {
        name: "platform-entry",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^platform-entry:/ }, (args) => ({
            path: args.path.slice("platform-entry:".length),
            namespace: "platform-entry",
          }));
          pluginBuild.onLoad({ filter: /.*/, namespace: "platform-entry" }, (args) => ({
            contents:
              (args.path === "zod" ? `export { default } from "zod";` : "") +
              ` export * from ${JSON.stringify(args.path)};`,
            resolveDir: sdkDir,
            loader: "js",
          }));
        },
      },
    ],
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd"],
    target: "es2022",
    minify: true,
    write: false,
    metafile: true,
    outdir,
    chunkNames: "node_modules/.platform/[name]-[hash]",
    external: ["cloudflare:workers", "node:async_hooks"],
  });
  const moduleName = (file: string) => path.relative(outdir, file).split(path.sep).join("/");
  const modules: Record<string, string> = {};
  for (const file of bundled.outputFiles) modules[moduleName(file.path)] = file.text;
  const imports: Record<string, string[]> = {};
  for (const [file, output] of Object.entries(bundled.metafile!.outputs)) {
    const name = moduleName(path.resolve(file));
    imports[name] = output.imports
      .filter((imported) => !imported.external)
      .map((imported) => moduleName(path.resolve(imported.path)));
  }
  return { modules, imports };
}

/** A project template this deployment offers: the GitHub reference a creation names it by, and the
 *  files a creation naming it is seeded with, so seeding it asks GitHub nothing. */
export type ConfigTemplate = { reference: string; files: Array<{ path: string; content: string }> };

/** Everything above, written. The presets a creation may name are core's own configs, then
 *  `templates`; a creation that names none gets core/configs/minimal. */
export async function build(options: { templates: ConfigTemplate[] }) {
  mkdirSync(path.join(root, "src/generated"), { recursive: true });
  const presets = [...coreConfigTemplates(), ...options.templates];
  const templates = presets.map(({ reference }) => ({ label: labelOf(reference), reference }));
  const templateFiles = Object.fromEntries(
    presets.map(({ reference, files }) => [reference, files]),
  );
  const minimalConfigFiles = trackedFiles(path.join(coreConfigs, "minimal"));
  writeFileSync(
    path.join(root, "src/generated/config-templates.js"),
    [
      `export const templates = ${JSON.stringify(templates)};`,
      `export const templateFiles = ${JSON.stringify(templateFiles)};`,
      `export const minimalConfigFiles = ${JSON.stringify(minimalConfigFiles)};`,
      "",
    ].join("\n"),
  );

  writeFileSync(
    path.join(root, "src/generated/platform-modules.js"),
    `export default ${JSON.stringify(await platformModules())};\n`,
  );
}

const coreConfigs = path.resolve(root, "../configs");

/**
 * Core's own configs (core/configs/<name>), each under its GitHub reference at this checkout's
 * commit (`githubHeadOf`). In a self-host's clone of iterate/core, which keeps the same paths, the
 * reference resolves on GitHub, so another deployment can create from it too. Once iterate's own
 * checkouts are of iterate/private, theirs resolves for nobody else: a build seeds its presets from
 * its own copy (src/project/processor.ts `presetFiles`).
 */
function coreConfigTemplates(): ConfigTemplate[] {
  const head = githubHeadOf(root);
  const names = readdirSync(coreConfigs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  // `default` first: the generated `templates` promises it there, and the dash and the consent page
  // start a person's project from it
  if (!names.includes("default"))
    throw new Error(
      "core/configs/default is missing: the dash and the consent page start a person's project from it",
    );
  return ["default", ...names.filter((name) => name !== "default")].map((name) => ({
    reference: formatConfigRepoTemplateReference({ ...head, path: `core/configs/${name}` }),
    files: trackedFiles(path.join(coreConfigs, name)),
  }));
}

/** The checkout at `checkout` as a template reference names it, without a folder: the GitHub
 *  repository its `origin` names, at its HEAD commit. Every template a build offers is named so
 *  (`github:<owner>/<repo>#<commit>&path:<folder>`), core's and those iterate's tooling gives it. */
export function githubHeadOf(checkout: string) {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  const origin = git("remote", "get-url", "origin");
  const repository = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(origin);
  if (!repository)
    throw new Error(
      `config templates are offered under a GitHub reference, so this checkout's origin must be a github.com repository, not ${origin}`,
    );
  const [, owner, repo] = repository;
  return { owner: owner!, repo: repo!, ref: git("rev-parse", "HEAD") };
}

/** A folder's files as git tracks them: not the node_modules/ an `npm install` for a local `tsc`
 *  leaves there. */
function trackedFiles(folder: string) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: folder, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .map((file) => ({ path: file, content: readFileSync(path.join(folder, file), "utf8") }));
}

/** A template's name in the dash: its folder (`core/configs/default` ⇒ `Default`), else its repo. */
function labelOf(reference: string) {
  const { repo, path: folder } = parseConfigRepoTemplateReference(reference);
  const name = folder?.split("/").at(-1) || repo;
  return name.charAt(0).toUpperCase() + name.slice(1).replaceAll("-", " ");
}

/**
 * The templates `--template <reference>` names, each a public GitHub folder
 * (`github:<owner>/<repo>#<ref>&path:<folder>`), pinned to its commit and downloaded. With
 * `--template-root <checkout>`, each is read from that local checkout of its repo instead (its
 * tracked files under `path:`), and its ref must already be a commit: the dev server's and CI's
 * templates are the checkout's own, pushed or not. Returns the other arguments as they were.
 */
export async function templatesFromArgs(args: string[]) {
  const rest: string[] = [];
  const references: string[] = [];
  let checkout: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--template") references.push(args[++index]!);
    else if (argument === "--template-root") checkout = args[++index];
    else rest.push(argument);
  }
  const templates = await Promise.all(
    references.map(async (reference): Promise<ConfigTemplate> => {
      const parsed = parseConfigRepoTemplateReference(reference);
      if (!checkout) {
        const pinned = await pinPublicGithubTemplate(parsed);
        return {
          reference: formatConfigRepoTemplateReference(pinned),
          files: await downloadPublicGithubTemplate(pinned),
        };
      }
      if (!/^[0-9a-f]{40}$/.test(parsed.ref || ""))
        throw new Error(
          `--template ${reference}: read from --template-root, its ref must be a commit`,
        );
      return {
        reference: formatConfigRepoTemplateReference(parsed),
        files: trackedFiles(path.resolve(checkout, parsed.path || ".")),
      };
    }),
  );
  return { templates, rest };
}

/** `vite build` of one deployment's Worker and its TanStack client into dist/. vite.config.ts gets
 *  the deployment from `OS_DEPLOYMENT` (generate-wrangler-config.ts `deploymentFromEnv`), never by
 *  looking its name up. */
export async function viteBuildOs(deployment: OsDeployableEnv) {
  await viteBuild(root, {
    CLOUDFLARE_ENV: deployment.name,
    OS_DEPLOYMENT: JSON.stringify(deployment),
  });
}

/** `build`, then `viteBuildOs`. */
export async function buildOs(deployment: OsDeployableEnv, templates: ConfigTemplate[]) {
  await build({ templates });
  await viteBuildOs(deployment);
}

// `pnpm build [--template <reference>]… [--template-root <checkout>]`: the generated modules, then
// `vite build` for CLOUDFLARE_ENV's deployment (a self-host's is `self-host`).
if (import.meta.main) {
  const { templates } = await templatesFromArgs(process.argv.slice(2));
  await build({ templates });
  await viteBuild(root, {});
}
