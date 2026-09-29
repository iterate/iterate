import { createRequire } from "node:module";
import { installAgents } from "@iterate-com/agents/install";
import { pkgPrNewVersion } from "@iterate-com/shared/pkg-pr-new";
import { installVoice } from "@iterate-com/voice/install";
import { build } from "esbuild";
import { inject } from "vitest";
import {
  olderSnapshotsExpired,
  openItx,
  publishConfig,
  sleep,
} from "../../os/e2e/support/client.ts";
import { installWorkspaceAgents } from "./agents-source.ts";
import { agentsWorkspaceConfig } from "./agents-workspace-config.ts";

/** A fresh root with the agents app installed from this checkout (`installWorkspaceAgents`). */
export async function openAgentItx(context: string) {
  const itx = openItx(context);
  await installWorkspaceAgents(itx);
  return itx;
}

/** Voice and the agents app on `root` the way a project's config repo installs them (configs/default):
 *  `agentsWorkspaceConfig` with `voice.ts` re-exporting `bundle` (`voiceWorkspaceBundle`, as a row
 *  rewrites it), published as the project's config, then `installAgents` and `installVoice`, as the
 *  init case calls them; the names they add answer everywhere once older snapshots expired. */
export async function installWorkspaceVoice(
  root: Parameters<typeof installAgents>[0] & Parameters<typeof installVoice>[0],
  bundle?: string,
) {
  await publishConfig(root, {
    ...agentsWorkspaceConfig,
    "voice.ts": 'export { default, VoiceAgentDurableObject } from "./voice-bundle.js";\n',
    "voice-bundle.js": bundle || (await voiceWorkspaceBundle()),
  });
  await installAgents(root);
  await installVoice(root);
  await olderSnapshotsExpired();
}

/** @iterate-com/voice as this checkout has it, as one module (its Markdown inlined, `iterate`, `zod`
 *  and `cloudflare:workers` left to the platform): what `voice.ts` re-exports, with no publish of
 *  the package. */
export async function voiceWorkspaceBundle(): Promise<string> {
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
  return result.outputFiles[0]!.text;
}

/** This checkout's pkg.pr.new build of one of the repository's packages, at the commit the build
 *  stamps the default template with (apps/os e2e/support/global-setup.ts
 *  `publishedPackageCommit`), waited for while the pkg.pr.new workflow publishes it. */
export async function publishedPackage(name: string): Promise<string> {
  const version = pkgPrNewVersion(name, inject("publishedPackageCommit"));
  for (
    const deadline = Date.now() + 60_000;
    !(await fetch(version, { method: "HEAD" })).ok;
    await sleep(3_000)
  )
    if (Date.now() > deadline) throw new Error(`pkg.pr.new has not published ${version}`);
  return version;
}
