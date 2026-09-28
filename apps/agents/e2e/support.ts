import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { matchesGlob } from "node:path";
import { installAgents, pkgPrNewVersion } from "@iterate-com/agents/install";
import { build } from "esbuild";
import { z } from "zod";
import { openItx, sleep } from "../../os/e2e/support/client.ts";
import { agentsWorkspaceSource } from "./agents-source.ts";

export async function openAgentItx(context: string) {
  const itx = openItx(context);
  await installAgents(itx, agentsWorkspaceSource);
  return itx;
}

/** @iterate-com/voice as this checkout has it, as one module (its Markdown inlined, `iterate`, `zod`
 *  and `cloudflare:workers` left to the platform): a source `installVoice` mounts without a publish. */
export async function voiceWorkspaceSource(): Promise<{ "index.js": string }> {
  const result = await build({
    // the workspace package's entry: its source
    entryPoints: [createRequire(import.meta.url).resolve("@iterate-com/voice")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    loader: { ".md": "text" },
    external: ["cloudflare:workers", "zod", "iterate", "iterate/*"],
    logLevel: "silent",
  });
  return { "index.js": result.outputFiles[0]!.text };
}

/** The paths whose change makes the pkg.pr.new workflow publish a PR: its own `pull_request.paths`. */
function publishPaths(): string[] {
  const workflow = readFileSync(
    new URL("../../../.github/workflows/pkg-pr-new.yml", import.meta.url).pathname,
    "utf8",
  );
  const block = workflow.slice(workflow.indexOf("pull_request:"), workflow.indexOf("\njobs:"));
  return [...block.matchAll(/^\s+- (\S+)$/gm)].map((match) => match[1]!);
}

/** GitHub's REST API for this repository, with the run's token when it has one, its answer parsed
 *  by `schema`. */
async function github<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const repository = process.env.GITHUB_REPOSITORY?.trim() || "iterate/iterate";
  const token = process.env.GITHUB_TOKEN?.trim();
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error(`GitHub answered ${path} with ${response.status}`);
  return schema.parse(await response.json());
}

/** Whether PR `pr` changes a path the pkg.pr.new workflow publishes on (GitHub's list of its files). */
async function prPublishesPackages(pr: string): Promise<boolean> {
  const globs = publishPaths();
  for (let page = 1; ; page++) {
    const files = await github(
      `pulls/${pr}/files?per_page=100&page=${page}`,
      z.array(z.object({ filename: z.string() })),
    );
    if (files.some(({ filename }) => globs.some((glob) => matchesGlob(filename, glob))))
      return true;
    if (files.length < 100) return false;
  }
}

/** How far back from a head the newest published build is looked for. Every main commit publishes,
 *  so only a branch's own unpublished commits and a main build still in flight stand between. */
const PUBLISHED_ANCESTOR_DEPTH = 30;

/** This checkout's pkg.pr.new build of one of the repository's packages: a real build of a commit,
 *  never `@main`, which the loader locks to whatever it first resolved. A PR that changes what the
 *  pkg.pr.new workflow publishes on gets its head published on every push, so its rows pin the head's
 *  build, waited for while that workflow runs beside the preview's deploy (a first push has no build
 *  of the PR at all until it lands). Any other run (Main OS e2e, a PR that publishes nothing, a
 *  dispatch) pins the newest build of a commit at or before its head, as GitHub lists them. A run
 *  that names no head (a local one) pins main's. */
export async function publishedPackage(name: string): Promise<string> {
  const at = (ref: string) => pkgPrNewVersion(name, ref);
  const published = async (ref: string) => (await fetch(at(ref), { method: "HEAD" })).ok;
  const pr = process.env.PREVIEW_PR_NUMBER?.trim();
  const head = process.env.TEST_TELEMETRY_HEAD_SHA?.trim();
  if (!head) return at("main");
  if (pr && (await prPublishesPackages(pr))) {
    for (const deadline = Date.now() + 60_000; !(await published(head)); await sleep(3_000))
      if (Date.now() > deadline) throw new Error(`pkg.pr.new has not published ${at(head)}`);
    return at(head);
  }
  const commits = await github(
    `commits?sha=${head}&per_page=${PUBLISHED_ANCESTOR_DEPTH}`,
    z.array(z.object({ sha: z.string() })),
  );
  for (const { sha } of commits) if (await published(sha)) return at(sha);
  throw new Error(
    `pkg.pr.new has published ${name} for none of the ${PUBLISHED_ANCESTOR_DEPTH} commits up to ${head}`,
  );
}
