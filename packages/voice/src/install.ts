// install.ts — what a config repo's init case calls (README.md), what Kit's Prepare and the voice
// app run for a project, and the Voice app's upgrade of the build the config pins. Voice is
// installed as the agents app is (@iterate-com/agents/install): the config repo depends on this
// package and re-exports its service and relay class from `voice.ts`, and every rule and row voice
// writes names that module of the project's published config. Not the runtime, so importing it
// loads none.
import type {} from "./api.ts"; // registers `itx.voice` on InstalledAppRoots
import type { FacetSpec, IterateContextApi, IterateContextApiWith, RepoHandle } from "iterate/api";
import { errorCode } from "iterate/lib";
import { z } from "zod";
import { SCREEN_FONT_CSS } from "./screen-font.ts";

/** Where voice's code is: `voice.ts` of the project's published config, with no cache key, so what
 *  runs changes only when that module's bundle does (a new pin of this package). */
const PUBLISHED: Omit<FacetSpec, "className"> = {
  mainModule: "voice.ts",
  source: ["itx", ["cd", "/"], "config"],
};

/** The relay facet each press puts beside its call's agent (worker.ts `setupVoiceAgent`). */
export const voiceAgentFacetSpec: FacetSpec = {
  className: "VoiceAgentDurableObject",
  ...PUBLISHED,
};

/** Idempotent: the screen font a screen script embeds (screen-context.md), and the `itx.voice` rule
 *  to `voice.ts`'s default export. Voice runs on the agents app, every call an agent, which the same
 *  init case installs (`installAgents`). */
export async function installVoice(
  itx: Pick<IterateContextApi, "append"> & { kv: Pick<IterateContextApi["kv"], "put"> },
) {
  await itx.kv.put("voice/screen-font.css", SCREEN_FONT_CSS);
  await itx.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.voice",
      target: ["itx", "workers", ["get", PUBLISHED]],
      description:
        "The project's installed voice service: setupVoiceAgent({ streamPath, activation, screen? }), setImage({ device, image }), health()",
    },
  });
}

const VoiceHealth = z.object({ ok: z.literal(true) });

/** What Kit's Prepare and the voice app run for a project: the OpenAI key (the live model's) stored
 *  when the project has none — `needs-openai-key` without one — then `itx.voice`, which the
 *  project's init case installs (`installVoice`), waited for up to a minute, and asked for
 *  `health()`. A project whose config repo neither has `itx.voice` nor pins this package never gets
 *  one: refused at once, before a key is stored. */
export async function ensureVoiceAgent(
  project: Pick<IterateContextApi, "waitForEvent"> & {
    secrets: Pick<IterateContextApi["secrets"], "list" | "set">;
    rewriteRules: Pick<IterateContextApi["rewriteRules"], "get">;
    repos: { get(path: string): Pick<RepoHandle, "readFile"> };
  },
  openaiKey?: string,
): Promise<"ready" | "needs-openai-key"> {
  const [secrets, rule] = await Promise.all([
    project.secrets.list(),
    project.rewriteRules.get("itx.voice"),
  ]);
  // A project created a moment ago may not have its config repo yet: wait for voice as below.
  const pinned = rule?.target
    ? undefined
    : await voiceVersion(project).catch((error: unknown) => {
        if (/: not created —/.test(String(error))) return "pending";
        throw error;
      });
  if (!rule?.target && !pinned)
    throw new Error(
      `This project's config repo does not install voice: its package.json lists no @iterate-com/voice, and its init case calls no installVoice(itx) (@iterate-com/voice/install), as configs/default does`,
    );
  if (!secrets.some((secret) => secret.path === "/secrets/openai")) {
    if (!openaiKey?.trim()) return "needs-openai-key";
    await project.secrets.set("/secrets/openai", openaiKey.trim(), {
      urls: ["https://api.openai.com"],
    });
  }
  if (!rule?.target) await voiceInstalled(project);
  // The rule is there, so the handle answers `voice`: the project's own service is still parsed,
  // since only ours is typed by VoiceApi.
  const installed = project as typeof project & Pick<IterateContextApiWith<"voice">, "voice">;
  VoiceHealth.parse(await installed.voice.health());
  return "ready";
}

/** The project's `itx.voice` rule, waited for up to a minute: a project created a moment ago gets
 *  it from its config repo's first init case. A failed creation refuses at once. */
async function voiceInstalled(project: Pick<IterateContextApi, "waitForEvent">) {
  const deadline = Date.now() + 60_000;
  for (let afterOffset = 0; ;) {
    const event = await project
      .waitForEvent({
        type: [
          "events.iterate.com/itx/rewrite-rule-configured",
          "events.iterate.com/project/create-failed",
        ],
        afterOffset,
        timeoutMs: Math.max(1, deadline - Date.now()),
      })
      .catch((error: unknown) => {
        if (errorCode(error) !== "WAIT_TIMEOUT") throw error;
        throw new Error(
          "Voice was not installed within a minute: the project's config repo pins @iterate-com/voice, and installs it with installVoice(itx) (@iterate-com/voice/install) in its init case, as configs/default does",
        );
      });
    if (event.type === "events.iterate.com/project/create-failed")
      throw new Error(
        `The project's creation failed, so its config repo installs no voice: ${String(event.payload?.error)}`,
      );
    // the root stores a rule's match normalized, as its steps (["itx", "voice"])
    const match = event.payload?.match;
    if ((Array.isArray(match) ? match.join(".") : match) === "itx.voice" && event.payload?.target)
      return;
    afterOffset = event.offset;
  }
}

/** The part of a config repo's root package.json an upgrade reads and rewrites; every other field
 *  is carried through untouched. */
type RootManifest = { dependencies?: Record<string, string> };

/** The build of voice the project's config pins: `@iterate-com/voice` among the dependencies of the
 *  root package.json at `main`'s tip of `/repos/config`, which `voice.ts` re-exports and the project
 *  runs once that commit's publication has landed. Undefined when the config pins no such package,
 *  or its package.json is not JSON. */
export async function voiceVersion(project: {
  repos: { get(path: string): Pick<RepoHandle, "readFile"> };
}): Promise<string | undefined> {
  const text = await project.repos.get("/repos/config").readFile("package.json");
  try {
    return (JSON.parse(text || "{}") as RootManifest).dependencies?.["@iterate-com/voice"];
  } catch {
    return undefined;
  }
}

/**
 * AN UPGRADE of the project's voice to `version`, a newer build of `@iterate-com/voice`: the root
 * package.json's pin, in ONE commit on the tip it read (refused if `main` moved meanwhile), then that
 * commit's publication awaited — the platform moves `itx.config` to it, and the next press loads the
 * new build (`voiceAgentFacetSpec`). A publication the platform refuses (the probe, a module that
 * does not resolve) throws why, with the pin committed. A config already at `version` commits
 * nothing. The agents app keeps its build: the config pins it too. Answers the commit the project
 * runs.
 */
export async function upgradeVoice(
  project: Pick<IterateContextApi, "readEvents" | "waitForEvent"> & {
    repos: { get(path: string): Pick<RepoHandle, "tip" | "readFile" | "commitFiles"> };
  },
  version: string,
): Promise<string> {
  const repo = project.repos.get("/repos/config");
  const tip = await repo.tip();
  if (!tip) throw new Error("The project's config repo has no commit to upgrade");
  const manifest = JSON.parse(
    (await repo.readFile("package.json", { commitOid: tip })) || "{}",
  ) as RootManifest;
  if (manifest.dependencies?.["@iterate-com/voice"] === version) return tip;
  // the head of `/` before the commit: its publication lands after it
  const { scannedThroughOffset } = await project.readEvents(Number.MAX_SAFE_INTEGER, 1);
  const { commitOid } = await repo.commitFiles({
    message: `Upgrade @iterate-com/voice to ${version}`,
    parent: tip,
    changes: [
      {
        path: "package.json",
        content: `${JSON.stringify(
          {
            ...manifest,
            dependencies: { ...manifest.dependencies, "@iterate-com/voice": version },
          },
          null,
          2,
        )}\n`,
      },
    ],
  });
  if (!commitOid) throw new Error("The upgrade's commit left the config repo's main unborn");
  // every commit gets one outcome on `/`, found by its oid
  const outcome = await project.waitForEvent({
    type: [
      "events.iterate.com/project/worker-updated",
      "events.iterate.com/project/worker-update-failed",
    ],
    payload: { commitOid },
    afterOffset: scannedThroughOffset,
    timeoutMs: 120_000,
  });
  if (outcome.type === "events.iterate.com/project/worker-updated") return commitOid;
  throw new Error(
    `package.json pins the new build (config commit ${commitOid.slice(0, 7)}), but its publication failed, so the project still runs the old one: ${String(outcome.payload?.error)}`,
  );
}
