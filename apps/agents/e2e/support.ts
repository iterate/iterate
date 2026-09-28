import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { matchesGlob } from "node:path";
import { installAgents } from "@iterate-com/agents/install";
import { pkgPrNewVersion } from "@iterate-com/shared/pkg-pr-new";
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

/** This checkout's pkg.pr.new build of one of the repository's packages: the build of one commit,
 *  waited for while the pkg.pr.new workflow publishes it, never `@main`, which the loader refuses
 *  (@iterate-com/shared/pkg-pr-new). A PR that changes what that workflow publishes on gets its head
 *  published on every push, so its rows pin the head (a first push has no build of the PR until it
 *  lands). Every main commit publishes, so any other run pins its head's merge base with main: the
 *  head itself on a main run, the main commit a PR that publishes nothing branched from. A run that
 *  names no head (a local one) pins this checkout's merge base with origin/main. */
export async function publishedPackage(name: string): Promise<string> {
  const at = (ref: string) => pkgPrNewVersion(name, ref);
  const ref = await publishedRef();
  for (
    const deadline = Date.now() + 60_000;
    !(await fetch(at(ref), { method: "HEAD" })).ok;
    await sleep(3_000)
  )
    if (Date.now() > deadline) throw new Error(`pkg.pr.new has not published ${at(ref)}`);
  return at(ref);
}

/** The commit whose build `publishedPackage` pins. */
async function publishedRef(): Promise<string> {
  const head = process.env.TEST_TELEMETRY_HEAD_SHA?.trim();
  if (!head)
    return execFileSync("git", ["merge-base", "HEAD", "origin/main"], { encoding: "utf8" }).trim();
  const pr = process.env.PREVIEW_PR_NUMBER?.trim();
  if (pr && (await prPublishesPackages(pr))) return head;
  const { merge_base_commit } = await github(
    `compare/main...${head}?per_page=1`,
    z.object({ merge_base_commit: z.object({ sha: z.string() }) }),
  );
  return merge_base_commit.sha;
}
