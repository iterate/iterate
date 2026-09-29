// __workers-tests__/voice-publication.test.ts — VOICE RUNS FROM THE PUBLISHED CONFIG, on the real
// platform: `installVoice` (@iterate-com/voice install.ts) writes `itx.voice` to `voice.ts` of the
// project's config pointer, and each press's relay facet is that module's class
// (`voiceAgentFacetSpec`). A publication that leaves `voice.ts`'s bundle as it was — the website
// changed — leaves the service answering as it did and the relay running; one that changes it, as a
// new pin of the package does, is the service's next call and restarts the relay on its next one,
// storage kept. The pointer is written by hand as the platform, its manifest naming each module by
// a version, and `voice.ts` stands in for the package: its relay counts its calls.
import { expect, test } from "vitest";
import { installVoice, voiceAgentFacetSpec } from "@iterate-com/voice/install";
import {
  adminCredentials,
  appendAsPlatform,
  openSession,
  stub,
} from "../../os/__workers-tests__/support.ts";

test("a website-only publication leaves voice's service and relay as they run; a new voice.ts is the service's next call and restarts the relay on its next one, its storage kept", async () => {
  const project = `prj_voice_publication_${crypto.randomUUID().slice(0, 8)}`;
  const itx = await (await openSession()).authenticate(adminCredentials()).projects.get(project);
  const service = () => itx.invoke(["itx", "voice", ["health"]]);
  const relay = () =>
    stub(`${project}.iterate/agents/voice/web/call`).invoke([
      "itx",
      "facets",
      ["get", "voice-agent", voiceAgentFacetSpec],
      ["boot"],
    ]) as Promise<{ version: string; instance: string; count: number }>;
  await publish(project, { generation: 1, voice: "v1", website: "w1" });
  await installVoice(itx);
  expect(await service()).toEqual({ ok: true, version: "v1" });
  const first = await relay();
  expect(first).toMatchObject({ version: "v1", count: 1 });

  await publish(project, { generation: 2, voice: "v1", website: "w2" });
  expect(await service()).toEqual({ ok: true, version: "v1" });
  expect(await relay()).toEqual({ ...first, count: 2 });

  await publish(project, { generation: 3, voice: "v2", website: "w2" });
  expect(await service()).toEqual({ ok: true, version: "v2" });
  const restarted = await relay();
  expect(restarted).toMatchObject({ version: "v2", count: 3 });
  expect(restarted).not.toMatchObject({ instance: first.instance });
});

/** `itx.config` on the project's root, as a publication writes it: `voice.ts` at `voice` — the
 *  service and the relay — and worker.js, the website, at `website`, each named in the manifest by
 *  its version. A re-point answers once every snapshot of the old pointer has expired. */
async function publish(
  project: string,
  { generation, voice, website }: { generation: number; voice: string; website: string },
) {
  const manifest = {
    generation,
    modules: {
      "voice.ts": { identity: `voice-${voice}`, classes: ["VoiceAgentDurableObject"] },
      "worker.js": { identity: `worker-${website}`, classes: [] },
    },
  };
  const source = {
    "package.json": '{"main":"worker.js"}',
    "worker.js": `import { IterateConfigEntrypoint } from "iterate/sdk";
export const homepage = ${JSON.stringify(website)};
export default class extends IterateConfigEntrypoint {}`,
    "voice.ts": `import { WorkerEntrypoint } from "cloudflare:workers";
import { FacetDurableObject } from "iterate/sdk";
export default class extends WorkerEntrypoint {
  health() {
    return { ok: true, version: ${JSON.stringify(voice)} };
  }
}
export class VoiceAgentDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "boot"];
  instance = crypto.randomUUID();
  boot() {
    const count = (this.ctx.storage.kv.get("count") ?? 0) + 1;
    this.ctx.storage.kv.put("count", count);
    return { version: ${JSON.stringify(voice)}, instance: this.instance, count };
  }
}`,
  };
  await appendAsPlatform(project, {
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.config",
      target: ["itx", "builtins", "workers", ["get", { source, manifest }]],
    },
  });
}
