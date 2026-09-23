import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { firmwareCatalog, firmwareManifestPath } from "../src/firmware/catalog.ts";

const Manifest = z.object({
  builds: z.array(
    z.object({
      parts: z.array(z.object({ path: z.string(), offset: z.number().int().nonnegative() })),
    }),
  ),
});

/** Verify the deployed bytes against the release assets used for this deployment. */
export async function verifyFirmwareAssets(baseUrl: string, headers?: Record<string, string>) {
  // Workers and their asset manifests can reach different locations at different
  // times. Allow two minutes of propagation, while still checking every byte.
  const maxAttempts = 25;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await verifyFirmwareAssetsOnce(baseUrl, headers);
      return;
    } catch (error) {
      if (attempt >= maxAttempts) throw error;
      console.log(
        `Firmware verification attempt ${attempt}/${maxAttempts} failed: ${String(error)}; retrying in 5 seconds for deployment propagation.`,
      );
      await setTimeout(5000);
    }
  }
}

async function verifyFirmwareAssetsOnce(baseUrl: string, headers?: Record<string, string>) {
  let parts = 0;
  let releases = 0;
  for (const device of firmwareCatalog) {
    for (const release of device.releases) {
      const manifestPath = firmwareManifestPath(device.id, release.version);
      const localUrl = new URL(`../dist/client${manifestPath}`, import.meta.url);
      const expected = await readFile(localUrl, "utf8");
      const publicUrl = new URL(manifestPath, baseUrl);
      const response = await fetch(publicUrl, { headers });
      const actual = await response.text();
      if (!response.ok || actual !== expected) {
        throw new Error(
          `${device.id}/${release.version}: HTTP ${response.status}; deployed manifest differs from the release; expected SHA-256 ${createHash("sha256").update(expected).digest("hex")}, received ${createHash("sha256").update(actual).digest("hex")}; CF-Ray ${response.headers.get("cf-ray")}`,
        );
      }
      const manifest = Manifest.parse(JSON.parse(expected));
      for (const build of manifest.builds) {
        await Promise.all(
          build.parts.map(async (part) => {
            const url = new URL(part.path, publicUrl);
            const local = await readFile(new URL(part.path, localUrl));
            const downloaded = await fetch(url, { headers });
            if (!downloaded.ok) throw new Error(`${url}: HTTP ${downloaded.status}`);
            const bytes = new Uint8Array(await downloaded.arrayBuffer());
            const expectedHash = createHash("sha256").update(local).digest("hex");
            if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
              throw new Error(`${url}: downloaded firmware hash differs from the release`);
            }
          }),
        );
        parts += build.parts.length;
      }
      releases += 1;
      console.log(`Verified ${device.id}/${release.version}`);
    }
  }
  const catalog = await fetch(new URL("/firmware/catalog.json", baseUrl), { headers });
  const expectedCatalog = await readFile(
    new URL("../dist/client/firmware/catalog.json", import.meta.url),
    "utf8",
  );
  if (!catalog.ok || (await catalog.text()) !== expectedCatalog) {
    throw new Error("Deployed firmware catalog differs from the release");
  }
  console.log(
    `Verified ${firmwareCatalog.length} devices, ${releases} releases and ${parts} firmware parts at ${baseUrl}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseUrl = process.argv[2];
  if (!baseUrl) throw new Error("Usage: verify-firmware-assets.ts <installer-origin>");
  await verifyFirmwareAssets(baseUrl);
}
