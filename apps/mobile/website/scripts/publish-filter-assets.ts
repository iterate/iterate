import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { mobileWebsiteEnvs } from "../../../../envs.ts";
import type { EnvContext } from "../../../../scripts/lib/env-context.ts";

/** Publish immutable data before deploying. Never delete older hashes: old
 * app/OTA versions still reference them. Uses the existing Cloudflare API
 * credentials; no S3 SDK, new service, or public upload endpoint. */
export async function publishFilterAssets(ctx: EnvContext<typeof mobileWebsiteEnvs.prd>) {
  const directory = new URL("../filter-assets/", import.meta.url);
  const assets = await Promise.all(
    (await readdir(directory)).map(async (filename) => {
      const match = /^([a-f0-9]{64})\.(png|jpeg|wasm\.gz|task\.gz)$/.exec(filename);
      if (!match) throw new Error(`Unexpected filter asset: ${filename}`);
      const bytes = await readFile(new URL(filename, directory));
      if (createHash("sha256").update(bytes).digest("hex") !== match[1]) {
        throw new Error(`Filter asset hash mismatch: ${filename}`);
      }
      return { filename, bytes };
    }),
  );
  let uploaded = 0;
  for (let i = 0; i < assets.length; i += 8) {
    const results = await Promise.allSettled(
      assets.slice(i, i + 8).map(async ({ filename, bytes }) => {
        const key = `filter-assets/${filename}`;
        const existing = await fetch(`${ctx.env.baseUrl}/${key}`, {
          method: "HEAD",
          signal: AbortSignal.timeout(30_000),
        });
        if (existing.ok) return;
        if (existing.status !== 404)
          throw new Error(`Filter asset preflight failed: ${filename} (${existing.status})`);
        // R2's object API returns raw responses, unlike the JSON envelopes
        // consumed by ctx.cf. Keep the existing account/token selection.
        const uploadedObject = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${ctx.env.cloudflareAccountId}/r2/buckets/${ctx.env.workerName}-state/objects/${key}`,
          {
            method: "PUT",
            body: bytes,
            headers: {
              "content-type": "application/octet-stream",
              authorization: `Bearer ${ctx.secrets.CLOUDFLARE_API_TOKEN}`,
            },
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!uploadedObject.ok)
          throw new Error(
            `Filter asset upload failed: ${filename} (${uploadedObject.status}): ${await uploadedObject.text()}`,
          );
        await uploadedObject.body?.cancel();
        uploaded += 1;
      }),
    );
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  console.log(
    `Filter assets: ${uploaded} published, ${assets.length - uploaded} already present; old hashes retained`,
  );
}
