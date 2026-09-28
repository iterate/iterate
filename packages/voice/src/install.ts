// install.ts — how a project installs voice. Like the agents app it builds on, voice is a SOURCE the
// project owns: a folder of its config repo (`voice/` by convention) holding a package.json that pins
// this package and names its `main`, worker.ts, which re-exports the voice worker and its relay facet
// class (`voiceFolder`). `installVoice` mounts that source as `itx.voice`; the press's relay facet
// loads the same source. Nothing here is the runtime, so a config worker imports
// `@iterate-com/voice/install` without loading it.
import type {} from "./api.ts";
// registers `itx.voice` on InstalledAppRoots
import {
  agentsApp,
  commitAppFolders,
  configRepoSettled,
  publishAgents,
  upgradeAgents,
} from "@iterate-com/agents/install";
import type { IterateContextApi, IterateContextApiWith, RepoHandle } from "iterate/api";
import { z } from "zod";
import { SCREEN_FONT_CSS } from "./screen-font.ts";

const VoiceHealth = z.object({ ok: z.literal(true) });

/** The source a project installs voice from, by file: `version` is what package.json pins, a
 *  pkg.pr.new URL at a commit (@iterate-com/agents/install `agentsFolder` says why) or an npm
 *  version once the package is on npm. */
export function voiceFolder(version: string): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ main: "worker.ts", dependencies: { "@iterate-com/voice": version } }, null, 2)}\n`,
    "worker.ts": 'export { default, VoiceAgentDurableObject } from "@iterate-com/voice";\n',
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
  const [{ path }, agents] = await Promise.all([itx.whoami(), itx.rewriteRules.get("itx.agents")]);
  if (path !== "/") throw new Error("Install voice at the project root");
  if (!agents?.target) throw new Error("Voice needs the agents app: install it first");
  const serialized = JSON.stringify(
    Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((name) => [name, source[name]]),
    ),
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  const cacheKey = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  await Promise.all([
    // Written before the rule: the worker reads its facets' source from here (worker.ts).
    itx.kv.put("voice/runtime", JSON.stringify({ cacheKey, source })),
    // A screen script embeds this in its HTML (screen-context.md).
    itx.kv.put("voice/screen-font.css", SCREEN_FONT_CSS),
  ]);
  await itx.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.voice",
      target: ["itx", "workers", ["get", { source, cacheKey }]],
      description:
        "The project's installed voice service: setupVoiceAgent({ streamPath, activation, screen? }), setImage({ device, image }), health()",
    },
  });
}

/** What Kit's Prepare and the voice app run for a project: store the OpenAI key when the project
 *  has none (`needs-openai-key` without one), then — for a project without `itx.voice` — the config
 *  repo's `agents/` (unless the project has `itx.agents`) and `voice/` folders as they are, or
 *  `agentsFolder(versions.agents)` and `voiceFolder(versions.voice)` committed there first, in one
 *  commit (`commitAppFolders`), and both installed from it. A project that has `itx.voice` keeps its
 *  own service: a broken one is an error, not permission to replace it. Either way the service must
 *  answer `health()`. Every step waits only on what it needs: the project's reads go at once, and
 *  the agents app's first load (`upgradeAgents`) runs beside voice's (`health()`), so a dependency
 *  set esm.sh has not built before is built for both packages at the same time. */
export async function ensureVoiceAgent(
  project: Parameters<typeof publishAgents>[0] &
    Parameters<typeof installVoice>[0] & {
      secrets: Pick<IterateContextApi["secrets"], "list" | "set">;
      repos: {
        get(path: string): Pick<RepoHandle, "listFiles" | "readFile" | "commitFiles" | "modules">;
      };
      waitForEvent: IterateContextApi["waitForEvent"];
    },
  versions: { agents: string; voice: string },
  openaiKey?: string,
): Promise<"ready" | "needs-openai-key"> {
  const [secrets, voiceRule, agentsRule] = await Promise.all([
    project.secrets.list(),
    project.rewriteRules.get("itx.voice"),
    project.rewriteRules.get("itx.agents"),
  ]);
  if (!secrets.some((secret) => secret.path === "/secrets/openai")) {
    if (!openaiKey?.trim()) return "needs-openai-key";
    await project.secrets.set("/secrets/openai", openaiKey.trim(), {
      urls: ["https://api.openai.com"],
    });
  }
  // The project's `itx.voice` rule exists once installed (published below, or its own), so its
  // handle answers `voice`; a project-owned service is still parsed, since only ours is typed by
  // VoiceApi.
  const installed = project as typeof project & Pick<IterateContextApiWith<"voice">, "voice">;
  if (voiceRule) {
    VoiceHealth.parse(await installed.voice.health());
    return "ready";
  }
  const withAgents = !agentsRule?.target;
  // A project installing the agents app too may have been created a moment ago (configRepoSettled).
  if (withAgents) await configRepoSettled(project);
  const voice = {
    dir: "voice",
    folder: voiceFolder(versions.voice),
    packageName: "@iterate-com/voice",
    version: versions.voice,
  };
  const repo = project.repos.get("/repos/config");
  const commitOid = await commitAppFolders(
    repo,
    withAgents ? [agentsApp(versions.agents), voice] : [voice],
  );
  const [agentsSource, voiceSource] = await Promise.all([
    withAgents ? repo.modules({ dir: "agents", commitOid }) : undefined,
    repo.modules({ dir: "voice", commitOid }),
  ]);
  if (agentsSource) await publishAgents(project, agentsSource);
  await installVoice(project, voiceSource);
  const [, health] = await Promise.all([
    withAgents && upgradeAgents(project),
    installed.voice.health(),
  ]);
  VoiceHealth.parse(health);
  return "ready";
}
