import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { firmwareCatalog, firmwareManifestPath } from "../src/firmware/catalog.ts";

const PUBLIC_FIRMWARE_ROOT = fileURLToPath(new URL("../public/firmware/", import.meta.url));
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9.-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

interface DownloadedArtifact {
  bytes: Uint8Array;
  sha256: string;
}

async function downloadVerified(input: {
  sourceUrl: string;
  expectedSha256: string;
  label: string;
}): Promise<DownloadedArtifact> {
  const url = new URL(input.sourceUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${input.label} must use an unauthenticated HTTPS source URL.`);
  }
  if (!SHA256.test(input.expectedSha256)) {
    throw new Error(`${input.label} has an invalid SHA-256 digest.`);
  }

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${input.label} returned HTTP ${response.status}.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== input.expectedSha256) {
    throw new Error(
      `${input.label} SHA-256 mismatch: expected ${input.expectedSha256}, received ${sha256}.`,
    );
  }
  return { bytes, sha256 };
}

function assertSafeSegment(value: string, label: string) {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`${label} ${JSON.stringify(value)} is not a safe firmware path segment.`);
  }
}

function assertSafeFileName(value: string, label: string) {
  if (basename(value) !== value || !SAFE_SEGMENT.test(value)) {
    throw new Error(`${label} ${JSON.stringify(value)} is not a safe firmware file name.`);
  }
}

function assertNoOverlappingEspRegions(
  regions: Array<{ label: string; offset: number; size: number }>,
) {
  const sorted = [...regions].sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (previous.offset + previous.size > current.offset) {
      throw new Error(
        `ESP flash regions overlap: ${previous.label} and ${current.label} at 0x${current.offset.toString(16)}.`,
      );
    }
  }
}

export async function syncFirmwareAssets() {
  // This directory is generated exclusively by this script. Clearing it
  // prevents removed catalog releases from lingering in a deployment.
  await rm(PUBLIC_FIRMWARE_ROOT, { recursive: true, force: true });
  await mkdir(PUBLIC_FIRMWARE_ROOT, { recursive: true });

  const publicDevices = [];

  for (const device of firmwareCatalog) {
    assertSafeSegment(device.id, "Device ID");
    const publicReleases = [];

    for (const release of device.releases) {
      assertSafeSegment(release.version, `${device.name} version`);
      const releaseDirectory = join(PUBLIC_FIRMWARE_ROOT, device.id, release.version);
      await mkdir(releaseDirectory, { recursive: true });

      if (release.artifact.kind === "esp-web-tools") {
        if (device.installMethod.kind !== "esp-web-tools") {
          throw new Error(
            `${device.name} has an ESP Web Tools artifact but uses ${device.installMethod.kind}.`,
          );
        }
        const names = new Set<string>();
        const downloadedParts = await Promise.all(
          release.artifact.parts.map(async (part) => {
            assertSafeFileName(part.fileName, `${device.name} ${release.version} file`);
            if (names.has(part.fileName)) {
              throw new Error(
                `${device.name} ${release.version} repeats file name ${part.fileName}.`,
              );
            }
            names.add(part.fileName);
            const downloaded = await downloadVerified({
              sourceUrl: part.sourceUrl,
              expectedSha256: part.sha256,
              label: `${device.name} ${release.version} ${part.fileName}`,
            });
            await writeFile(join(releaseDirectory, part.fileName), downloaded.bytes);
            return { part, size: downloaded.bytes.byteLength };
          }),
        );
        assertNoOverlappingEspRegions([
          ...downloadedParts.map(({ part, size }) => ({
            label: part.fileName,
            offset: part.offset,
            size,
          })),
          {
            label: "iterate-kit/v1 configuration",
            offset: release.artifact.configurationPartition.offset,
            size: release.artifact.configurationPartition.size,
          },
        ]);

        const manifest = {
          name: device.name,
          version: release.version,
          new_install_prompt_erase: true,
          new_install_improv_wait_time: 0,
          builds: [
            {
              chipFamily: device.installMethod.chipFamily,
              parts: release.artifact.parts.map((part) => ({
                path: `./${part.fileName}`,
                offset: part.offset,
              })),
            },
          ],
        };
        await writeFile(
          join(releaseDirectory, "manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
        );
        publicReleases.push({
          version: release.version,
          artifact: {
            kind: release.artifact.kind,
            manifestPath: firmwareManifestPath(device.id, release.version),
          },
        });
        continue;
      }

      if (release.artifact.kind === "external-tool") {
        publicReleases.push({
          version: release.version,
          artifact: release.artifact,
        });
        continue;
      }

      assertSafeFileName(release.artifact.fileName, `${device.name} ${release.version} file`);
      const downloaded = await downloadVerified({
        sourceUrl: release.artifact.sourceUrl,
        expectedSha256: release.artifact.sha256,
        label: `${device.name} ${release.version} ${release.artifact.fileName}`,
      });
      await writeFile(join(releaseDirectory, release.artifact.fileName), downloaded.bytes);
      publicReleases.push({
        version: release.version,
        artifact: {
          kind: release.artifact.kind,
          path: `/firmware/${device.id}/${release.version}/${release.artifact.fileName}`,
          sha256: downloaded.sha256,
        },
      });
    }

    publicDevices.push({
      id: device.id,
      name: device.name,
      installMethod: device.installMethod,
      releases: publicReleases,
    });
  }

  await writeFile(
    join(PUBLIC_FIRMWARE_ROOT, "catalog.json"),
    `${JSON.stringify({ schemaVersion: 1, devices: publicDevices }, null, 2)}\n`,
  );
  console.log(
    `Synced ${publicDevices.reduce((total, device) => total + device.releases.length, 0)} firmware releases into ${PUBLIC_FIRMWARE_ROOT}`,
  );
}

if (process.argv[1]?.endsWith("sync-firmware-assets.ts")) {
  await syncFirmwareAssets();
}
