import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { z } from "zod";
import type { mobileWebsiteEnvs } from "../../../envs.ts";
import type { EnvContext } from "../../../scripts/lib/env-context.ts";
import {
  MEDIAPIPE_WASM_GZ_URL,
  FACE_LANDMARKER_MODEL_GZ_URL,
} from "../src/lib/filters/mediapipe-assets.generated.ts";
import { createAssetStore } from "./filter-asset-store.ts";

/** Check published data before releasing updated asset manifests. */
export async function verifyFilterAssets(ctx: EnvContext<typeof mobileWebsiteEnvs.prd>) {
  const store = createAssetStore({
    objectsUrl: `https://api.cloudflare.com/client/v4/accounts/${ctx.env.cloudflareAccountId}/r2/buckets/${ctx.env.workerName}-state/objects`,
    token: ctx.secrets.CLOUDFLARE_API_TOKEN,
  });
  const urls = [MEDIAPIPE_WASM_GZ_URL, FACE_LANDMARKER_MODEL_GZ_URL];
  for (const name of [
    "backdrops",
    "animal-faces",
    "flashcards-cartoon",
    "flashcards-encyclopaedia",
    "flashcards-photo",
  ]) {
    const source = await readFile(
      new URL(`../src/lib/filters/${name}.generated.json`, import.meta.url),
      "utf8",
    );
    const manifest = z
      .record(z.string(), z.union([z.string().url(), z.object({ url: z.string().url() })]))
      .parse(JSON.parse(source));
    urls.push(
      ...Object.values(manifest).map((entry) => (typeof entry === "string" ? entry : entry.url)),
    );
  }
  const missing: string[] = [];
  for (let i = 0; i < urls.length; i += 8) {
    const results = await Promise.allSettled(
      urls.slice(i, i + 8).map(async (url) => {
        if (!(await store.exists(url))) missing.push(url);
      }),
    );
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  if (missing.length) {
    throw new Error(
      `Unpublished filter assets:\n${missing.join("\n")}\nRun the manual generator and commit the updated manifests before publishing an app update.`,
    );
  }
  console.log(`Filter assets: ${urls.length} uploaded objects verified; no generation or uploads`);
}
