import type { IterateContextApi } from "iterate/api";
import { z } from "zod";
import { installAgents } from "../../../configs/with-agents/agents/install.ts";

const VoiceFileKey = z.string().regex(/^voice\/[a-f0-9]{64}\/[a-z-]+\.(js|css)$/);
const VoiceInstall = z.object({
  agentsRuntime: z.record(z.string(), z.string()),
  files: z.record(VoiceFileKey, z.string().min(1)),
  workerKey: VoiceFileKey,
  cacheKey: z.string().regex(/^voice-worker:[a-f0-9]{64}$/),
});
const VoiceHealth = z.object({ ok: z.literal(true) });

/** The voice install an app serves beside itself at `/voice-install.json` (written at build time by
 *  apps/agents/scripts/build-voice-install.ts): Kit and voice.iterate.com each serve their own copy. */
export async function fetchVoiceInstall(): Promise<z.infer<typeof VoiceInstall>> {
  const response = await fetch("/voice-install.json", { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("Could not download voice setup. Please try again.");
  return VoiceInstall.parse(await response.json());
}

/** Kit mints its device grant only after this succeeds. Partial uploads are safe to retry:
 * content-addressed files are written first, then one durable rule publishes the service. */
export async function ensureVoiceAgent(
  project: Parameters<typeof installAgents>[0] & {
    secrets: Pick<IterateContextApi["secrets"], "list" | "set">;
    rewriteRules: Pick<IterateContextApi["rewriteRules"], "get">;
  },
  loadInstall: () => Promise<z.infer<typeof VoiceInstall>>,
  openaiKey?: string,
): Promise<"ready" | "needs-openai-key"> {
  const secrets = await project.secrets.list();
  if (!secrets.some((secret) => secret.path === "/secrets/openai")) {
    if (!openaiKey?.trim()) return "needs-openai-key";
    await project.secrets.set("/secrets/openai", openaiKey.trim(), {
      urls: ["https://api.openai.com"],
    });
  }
  // Existing/custom voice services belong to the project. A broken service is an error,
  // not permission to replace it, and a second device must not reinstall a working one.
  if (!(await project.rewriteRules.get("itx.voice"))) {
    const install = VoiceInstall.parse(await loadInstall());
    if (!install.files[install.workerKey])
      throw new Error("Voice installation is missing its worker");
    await Promise.all(
      Object.entries(install.files).map(([key, source]) => project.kv.put(key, source)),
    );
    if (!(await project.rewriteRules.get("itx.agents"))?.target)
      await installAgents(project, install.agentsRuntime);
    await project.append({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      idempotencyKey: `voice/install/${install.cacheKey}`,
      payload: {
        match: "itx.voice",
        target: [
          "itx",
          "workers",
          [
            "get",
            {
              source: `itx.kv.get(${JSON.stringify(install.workerKey)})`,
              cacheKey: install.cacheKey,
              // The context the call started at, filled by the platform: the worker creates and
              // sets up agents beneath it only (worker.ts).
              props: { caller: { "@caller": true } },
            },
          ],
        ],
      },
    });
  }
  VoiceHealth.parse(await project.invoke(["itx", "voice", ["health"]]));
  return "ready";
}
