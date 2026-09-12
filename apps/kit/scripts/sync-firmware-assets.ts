import { mkdir, rm, writeFile, copyFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { firmwareCatalog, firmwareManifestPath } from "../src/firmware/catalog.ts";
import { readFirmwareReleaseBuild } from "./build-firmware-assets.ts";

const PUBLIC_FIRMWARE_ROOT = fileURLToPath(new URL("../public/firmware/", import.meta.url));
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

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
  const sorted = regions.toSorted((left, right) => left.offset - right.offset);
  let previous: (typeof sorted)[number] | undefined;
  for (const current of sorted) {
    if (previous && previous.offset + previous.size > current.offset) {
      throw new Error(
        `ESP flash regions overlap: ${previous.label} and ${current.label} at 0x${current.offset.toString(16)}.`,
      );
    }
    previous = current;
  }
}

export async function syncFirmwareAssets() {
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
      const build = await readFirmwareReleaseBuild(release);
      const parts = await Promise.all(
        release.artifact.parts.map(async (part) => {
          assertSafeFileName(part.fileName, `${device.name} ${release.version} file`);
          const built = build.parts.find(
            (candidate) =>
              candidate.buildPath === part.buildPath &&
              candidate.fileName === part.fileName &&
              candidate.offset === part.offset,
          );
          if (!built) throw new Error(`${device.name} cache is missing ${part.fileName}.`);
          const publishedFileName = `${built.sha256}-${part.fileName}`;
          await copyFile(
            join(build.directory, "build", part.buildPath),
            join(releaseDirectory, publishedFileName),
          );
          return {
            ...built,
            publishedFileName,
            size: (await stat(join(releaseDirectory, publishedFileName))).size,
          };
        }),
      );
      assertNoOverlappingEspRegions([
        ...parts.map(({ fileName, offset, size }) => ({ label: fileName, offset, size })),
        {
          label: "iterate-kit/v1 configuration",
          offset: release.artifact.configurationPartition.offset,
          size: release.artifact.configurationPartition.size,
        },
      ]);
      await writeFile(
        join(releaseDirectory, "manifest.json"),
        `${JSON.stringify(
          {
            name: device.name,
            version: release.version,
            new_install_prompt_erase: true,
            new_install_improv_wait_time: 0,
            builds: [
              {
                chipFamily: device.installMethod.chipFamily,
                parts: parts.map((part) => ({
                  path: `./${part.publishedFileName}`,
                  offset: part.offset,
                })),
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      publicReleases.push({
        version: release.version,
        artifact: {
          kind: "esp-web-tools",
          manifestPath: firmwareManifestPath(device.id, release.version),
          sourceFingerprint: build.sourceFingerprint,
          parts: parts.map(({ fileName, offset, sha256 }) => ({ fileName, offset, sha256 })),
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
