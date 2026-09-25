import { createRequire } from "node:module";
import { installAgents, pkgPrNewVersion } from "@iterate-com/agents/install";
import { build } from "esbuild";
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

/** This checkout's pkg.pr.new build of one of the repository's packages. A PR that changes the
 *  packages is published on every push (`@<pr>` exists), so its rows pin the head's build, waited
 *  for while the pkg.pr.new workflow runs beside the preview's deploy; any other run pins main's. */
export async function publishedPackage(name: string): Promise<string> {
  const at = (ref: string) => pkgPrNewVersion(name, ref);
  const published = async (ref: string) => (await fetch(at(ref), { method: "HEAD" })).ok;
  const pr = process.env.PREVIEW_PR_NUMBER?.trim();
  const head = process.env.TEST_TELEMETRY_HEAD_SHA?.trim();
  if (!pr || !head || !(await published(pr))) return at("main");
  for (const deadline = Date.now() + 60_000; !(await published(head)); await sleep(3_000))
    if (Date.now() > deadline) throw new Error(`pkg.pr.new has not published ${at(head)}`);
  return at(head);
}
