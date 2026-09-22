import type { IterateContextApi } from "iterate/next/api";
import { z } from "zod";
import { installAgents } from "../../../agents/runtime/install.ts";

const VoiceFileKey = z.string().regex(/^kit\/voice\/[a-f0-9]{64}\/[a-z-]+\.(js|css)$/);
export const VoiceInstall = z.object({
  agentsRuntime: z.string().min(1),
  files: z.record(VoiceFileKey, z.string().min(1)),
  workerKey: VoiceFileKey,
  cacheKey: z.string().regex(/^voice-worker:[a-f0-9]{64}$/),
});
const VoiceHealth = z.object({ ok: z.literal(true) });

/** No device grant is minted until this succeeds. Partial uploads are safe to retry:
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
      idempotencyKey: `kit/install/${install.cacheKey}`,
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
            },
          ],
        ],
      },
    });
  }
  VoiceHealth.parse(await project.invoke(["itx", "voice", ["health"]]));
  return "ready";
}
