import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { build, version as esbuildVersion } from "esbuild";

/** A reproducible local source artifact for a preview config repo. */
export type LocalVoiceAgentArtifact = { sha256: string; source: string };

const LOCAL_ARTIFACT_PREFIX = "// Local voice-agent source artifact; sha256=";

const ENTRYPOINT = fileURLToPath(
  new URL("../../../../packages/voice-agent/src/worker.ts", import.meta.url),
);

/**
 * Bundle the checked-out voice worker into the config repo's entry file.
 * Platform packages stay external and are resolved by the preview's normal
 * worker builder; this artifact contains no pkg.pr.new dependency.
 */
export async function buildLocalVoiceAgentArtifact(): Promise<LocalVoiceAgentArtifact> {
  const result = await build({
    bundle: true,
    conditions: ["workerd", "worker", "import", "default"],
    entryPoints: [ENTRYPOINT],
    external: ["cloudflare:workers", "iterate", "iterate/*", "zod"],
    format: "esm",
    logLevel: "silent",
    platform: "neutral",
    target: "es2022",
    write: false,
  });
  const body = result.outputFiles.at(0)?.text;
  if (body === undefined) throw new Error("esbuild produced no voice-agent artifact");
  const sha256 = createHash("sha256").update(body).digest("hex");
  return {
    sha256,
    source: `${LOCAL_ARTIFACT_PREFIX}${sha256}; esbuild=${esbuildVersion}.\n` + body,
  };
}

/** The hash recorded on an auditable local preview source, when present. */
export function localVoiceAgentArtifactHash(source: string | null): string | null {
  const match = source?.match(
    /^\/\/ Local voice-agent source artifact; sha256=([a-f0-9]{64}); esbuild=.+\.$/m,
  );
  return match?.[1] ?? null;
}
