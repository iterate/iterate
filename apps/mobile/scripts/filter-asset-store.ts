import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";

const Position = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export const AnimalAnchors = z.object({
  leftEye: Position,
  rightEye: Position,
  mouth: Position,
  eyeWidth: z.number().positive().max(1),
  mouthWidth: z.number().positive().max(1),
});
const AssetUrl = z
  .string()
  .regex(
    /^https:\/\/mobile\.iterate\.com\/filter-assets\/(?:[a-z0-9]+-)*[a-f0-9]{64}\.(?:png|jpeg|wasm\.gz|task\.gz)$/,
  );
const Manifest = z.record(
  z.string(),
  z.union([AssetUrl, z.object({ url: AssetUrl, anchors: AnimalAnchors })]),
);

/** The R2 object API returns raw bodies. Read it directly so an older website
 * deployment cannot make existing objects look missing. Never delete objects. */
export function createAssetStore(options: { objectsUrl: string; token: string }) {
  return {
    async exists(url: string) {
      AssetUrl.parse(url);
      const response = await fetch(options.objectsUrl + new URL(url).pathname, {
        headers: { authorization: `Bearer ${options.token}` },
        signal: AbortSignal.timeout(30_000),
      });
      await response.body?.cancel();
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`Asset check failed (${response.status}): ${url}`);
      return true;
    },
    async upload(slug: string, extension: string, bytes: Buffer) {
      const filename = `${slug}-${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
      const url = AssetUrl.parse(`https://mobile.iterate.com/filter-assets/${filename}`);
      const response = await fetch(options.objectsUrl + new URL(url).pathname, {
        method: "PUT",
        body: new Uint8Array(bytes),
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/octet-stream",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok)
        throw new Error(
          `Asset upload failed (${response.status}): ${filename}: ${await response.text()}`,
        );
      await response.body?.cancel();
      return url;
    },
  };
}

export async function syncAssetManifest(input: {
  manifestPath: string;
  recipes: {
    id: string;
    slug: string;
    extension: string;
    generate: () => Promise<{ bytes: Buffer; anchors?: z.infer<typeof AnimalAnchors> }>;
  }[];
  store: ReturnType<typeof createAssetStore>;
  slug: string | undefined;
  force: boolean;
}) {
  const selected = input.recipes.filter((recipe) => !input.slug || recipe.slug === input.slug);
  if (!selected.length) throw new Error(`Unknown asset slug: ${input.slug}`);
  const source = await readFile(input.manifestPath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    },
  );
  const manifest = Manifest.parse(JSON.parse(source));
  let generated = 0;
  let kept = 0;
  for (let offset = 0; offset < selected.length; offset += 8) {
    const batch = selected.slice(offset, offset + 8);
    // Check in small batches; generation and manifest writes stay sequential.
    const checks = await Promise.allSettled(
      batch.map(async (recipe) => {
        const current = manifest[recipe.id];
        const url = typeof current === "string" ? current : current?.url;
        if (input.force || !url) return false;
        return input.store.exists(url);
      }),
    );
    for (const result of checks) if (result.status === "rejected") throw result.reason;
    for (const [index, recipe] of batch.entries()) {
      const check = checks[index];
      if (check.status === "fulfilled" && check.value) {
        kept++;
        continue;
      }
      const image = await recipe.generate();
      const uploadedUrl = await input.store.upload(recipe.slug, recipe.extension, image.bytes);
      manifest[recipe.id] = image.anchors
        ? { url: uploadedUrl, anchors: image.anchors }
        : uploadedUrl;
      // Save each successful asset, atomically. An interrupted long run keeps its
      // progress; failed generation/upload leaves the current manifest intact.
      const temporary = `${input.manifestPath}.tmp`;
      await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n");
      await rename(temporary, input.manifestPath);
      generated++;
      console.log(`${recipe.slug}: uploaded ${Math.round(image.bytes.length / 1024)} KB`);
    }
  }
  return { generated, kept };
}
