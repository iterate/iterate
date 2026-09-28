// install.ts — how a project installs voice. Like the agents app it builds on, voice is a SOURCE the
// project owns: a folder of its config repo (`voice/` by convention) holding a package.json that pins
// this package and a worker.ts that re-exports the voice worker and its two facet classes
// (`voiceFolder`). `installVoice` mounts that source as `itx.voice`; the press's facets load the
// same source. Nothing here is the runtime, so a config worker imports `@iterate-com/voice/install`
// without loading it.
import type {} from "./api.ts";
// registers `itx.voice` on InstalledAppRoots
import { ensureAgents, ensureAppFolder, sourceCacheKey } from "@iterate-com/agents/install";
import type { IterateContextApi, IterateContextApiWith } from "iterate/api";
import { z } from "zod";
import { SCREEN_FONT_CSS } from "./screen-font.ts";

const VoiceHealth = z.object({ ok: z.literal(true) });

/** The source a project installs voice from, by file: `version` is what package.json pins (a
 *  pkg.pr.new URL). */
export function voiceFolder(version: string): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ dependencies: { "@iterate-com/voice": version } }, null, 2)}\n`,
    "worker.ts":
      'export { default, VoiceAgentDurableObject, VoiceDelegateDurableObject } from "@iterate-com/voice";\n',
  };
}

/** Mount voice from its source (`voiceFolder`, as `repo.modules({ dir })` answers it) at
 *  `itx.voice`. Voice runs on the agents app (every call is an agent), so `itx.agents` must be
 *  installed. Installing the same source again changes nothing; a new source is an upgrade that the
 *  next press loads. */
export async function installVoice(
  itx: Pick<IterateContextApi, "whoami" | "append"> & {
    kv: Pick<IterateContextApi["kv"], "put">;
    rewriteRules: Pick<IterateContextApi["rewriteRules"], "get">;
  },
  source: Record<string, string>,
) {
  const { path } = await itx.whoami();
  if (path !== "/") throw new Error("Install voice at the project root");
  if (!(await itx.rewriteRules.get("itx.agents"))?.target)
    throw new Error("Voice needs the agents app: install it first");
  const cacheKey = await sourceCacheKey(source);
  // Written before the rule: the worker reads its facets' source from here (worker.ts).
  await itx.kv.put("voice/runtime", JSON.stringify({ cacheKey, source }));
  // A screen script embeds this in its HTML (screen-context.md).
  await itx.kv.put("voice/screen-font.css", SCREEN_FONT_CSS);
  await itx.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.voice",
      target: ["itx", "workers", ["get", { source, cacheKey }]],
      description:
        "The project's installed voice service: setupVoiceAgent({ activation }), setImage({ device, image }), health()",
    },
  });
}

/** What Kit's Prepare and the voice app run for a project: store the OpenAI key when the project
 *  has none (`needs-openai-key` without one), then — for a project without `itx.voice` — the agents
 *  app (`ensureAgents`), the config repo's `voice/` folder as it is or `voiceFolder(voiceVersion)`
 *  committed there first, installed. A project that has `itx.voice` keeps its own service: a broken
 *  one is an error, not permission to replace it. Either way the service must answer `health()`. */
export async function ensureVoiceAgent(
  project: Parameters<typeof ensureAgents>[0] &
    Parameters<typeof installVoice>[0] & {
      secrets: Pick<IterateContextApi["secrets"], "list" | "set">;
    },
  versions: { agents: string; voice: string },
  openaiKey?: string,
): Promise<"ready" | "needs-openai-key"> {
  const secrets = await project.secrets.list();
  if (!secrets.some((secret) => secret.path === "/secrets/openai")) {
    if (!openaiKey?.trim()) return "needs-openai-key";
    await project.secrets.set("/secrets/openai", openaiKey.trim(), {
      urls: ["https://api.openai.com"],
    });
  }
  if (!(await project.rewriteRules.get("itx.voice"))) {
    await ensureAgents(project, versions.agents);
    const source = await ensureAppFolder(project.repos.get("/repos/config"), {
      dir: "voice",
      folder: voiceFolder(versions.voice),
      packageName: "@iterate-com/voice",
      version: versions.voice,
    });
    await installVoice(project, source);
  }
  // The project's `itx.voice` rule exists now (published above, or its own), so its handle answers
  // `voice`; a project-owned service is still parsed, since only ours is typed by VoiceApi.
  const installed = project as typeof project & Pick<IterateContextApiWith<"voice">, "voice">;
  VoiceHealth.parse(await installed.voice.health());
  return "ready";
}
