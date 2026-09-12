import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { firmwareCatalog, type EspWebToolsFirmwareRelease } from "../src/firmware/catalog.ts";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_ROOT = join(APP_ROOT, "..", "..");
const FIRMWARE_ROOT = join(APP_ROOT, "firmware");
const CACHE_ROOT = join(FIRMWARE_ROOT, ".build", "releases");
const METADATA_FILE = "release.json";
let derivedSourcesReady = false;

interface BuiltPart {
  buildPath: string;
  fileName: string;
  offset: number;
  sha256: string;
}

const Metadata = z.object({
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  target: z.string().min(1),
  version: z.string().min(1),
  toolchain: z.string().min(1),
  parts: z.array(
    z.object({
      buildPath: z.string().min(1),
      fileName: z.string().min(1),
      offset: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
});
const FlasherArgs = z.object({
  flash_files: z.record(z.string().regex(/^0x[0-9a-f]+$/), z.string().min(1)),
});

export interface FirmwareReleaseBuild {
  directory: string;
  parts: readonly BuiltPart[];
  sourceFingerprint: string;
}

function run(command: string, args: string[], cwd?: string, showOutput = true) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
      if (showOutput) process.stdout.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(" ")} exited ${code ?? "without a status"}.`));
    });
  });
}

async function hashFile(hash: ReturnType<typeof createHash>, path: string) {
  hash.update(relative(APP_ROOT, path));
  hash.update(await readFile(path));
}

async function trackedFirmwareInputs() {
  const files = await run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "apps/kit/firmware"],
    REPOSITORY_ROOT,
    false,
  );
  return files
    .trim()
    .split("\n")
    .filter((path) => path && !path.includes("/tests/") && !path.endsWith(".md"))
    .sort();
}

async function sourceFingerprint(toolchain: string) {
  const hash = createHash("sha256");
  hash.update(toolchain);
  for (const path of await trackedFirmwareInputs())
    await hashFile(hash, join(REPOSITORY_ROOT, path));
  await hashFile(hash, join(APP_ROOT, "src", "firmware", "catalog.ts"));
  return hash.digest("hex");
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readPartition(bytes: Uint8Array, name: string) {
  const decoder = new TextDecoder();
  for (let cursor = 0; cursor + 32 <= bytes.byteLength; cursor += 32) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, 32);
    if (view.getUint16(0, true) !== 0x50aa) break;
    const labelBytes = bytes.subarray(cursor + 12, cursor + 28);
    const label = decoder.decode(
      labelBytes.subarray(0, labelBytes.indexOf(0) === -1 ? 16 : labelBytes.indexOf(0)),
    );
    if (label === name) return { offset: view.getUint32(4, true), size: view.getUint32(8, true) };
  }
  throw new Error(`ESP-IDF partition table is missing ${name}.`);
}

function expectedFlashFiles(release: EspWebToolsFirmwareRelease) {
  return release.artifact.parts
    .map((part) => ({ offset: part.offset, buildPath: part.buildPath }))
    .sort((left, right) => left.offset - right.offset);
}

function assertFlashPlan(release: EspWebToolsFirmwareRelease, flashFiles: Record<string, string>) {
  const actual = Object.entries(flashFiles)
    .map(([offset, buildPath]) => ({ offset: Number.parseInt(offset, 16), buildPath }))
    .sort((left, right) => left.offset - right.offset);
  if (JSON.stringify(actual) !== JSON.stringify(expectedFlashFiles(release))) {
    throw new Error(
      `${release.artifact.target} ESP-IDF flash plan does not match the reviewed catalog release.`,
    );
  }
}

async function readCurrentBuild(input: {
  release: EspWebToolsFirmwareRelease;
  directory: string;
  sourceFingerprint: string;
  toolchain: string;
}): Promise<FirmwareReleaseBuild | undefined> {
  const metadataPath = join(input.directory, METADATA_FILE);
  try {
    const metadata = Metadata.parse(JSON.parse(await readFile(metadataPath, "utf8")));
    if (
      metadata.sourceFingerprint !== input.sourceFingerprint ||
      metadata.target !== input.release.artifact.target ||
      metadata.version !== input.release.version ||
      metadata.toolchain !== input.toolchain
    ) {
      return undefined;
    }
    const parts = await Promise.all(
      input.release.artifact.parts.map(async (part) => {
        const built = metadata.parts.find(
          (candidate) =>
            candidate.buildPath === part.buildPath &&
            candidate.fileName === part.fileName &&
            candidate.offset === part.offset,
        );
        if (!built)
          throw new Error(`${input.release.artifact.target} cache is missing ${part.fileName}.`);
        const bytes = await readFile(join(input.directory, "build", part.buildPath));
        if (sha256(bytes) !== built.sha256) {
          throw new Error(
            `${input.release.artifact.target} cache hash changed for ${part.fileName}.`,
          );
        }
        return built;
      }),
    );
    return { directory: input.directory, parts, sourceFingerprint: input.sourceFingerprint };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function idfVersion() {
  try {
    return (await run("idf.py", ["--version"])).trim();
  } catch {
    throw new Error(
      "ESP-IDF is not active. Source $IDF_PATH/export.sh before pnpm firmware:release.",
    );
  }
}

async function generateDerivedFirmwareSources() {
  if (derivedSourcesReady) return;
  await run("python3", [join(FIRMWARE_ROOT, "tools", "generate-atlases.py")], APP_ROOT);
  derivedSourcesReady = true;
}

export async function buildFirmwareRelease(release: EspWebToolsFirmwareRelease) {
  await generateDerivedFirmwareSources();
  const toolchain = await idfVersion();
  const fingerprint = await sourceFingerprint(toolchain);
  const directory = join(CACHE_ROOT, release.artifact.target, release.version, fingerprint);
  const cached = await readCurrentBuild({
    release,
    directory,
    sourceFingerprint: fingerprint,
    toolchain,
  });
  if (cached) return cached;

  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const targetDirectory = join(FIRMWARE_ROOT, "targets", release.artifact.target);
  const buildDirectory = join(directory, "build");
  const sdkconfig = join(directory, "sdkconfig");
  await run(
    "idf.py",
    [
      "-C",
      targetDirectory,
      "-B",
      buildDirectory,
      "-D",
      "IDF_TARGET=esp32s3",
      "-D",
      `SDKCONFIG=${sdkconfig}`,
      "build",
    ],
    APP_ROOT,
  );

  const flasherArgs = FlasherArgs.parse(
    JSON.parse(await readFile(join(buildDirectory, "flasher_args.json"), "utf8")),
  );
  assertFlashPlan(release, flasherArgs.flash_files);
  const partition = await readFile(join(buildDirectory, "partition_table", "partition-table.bin"));
  const config = readPartition(partition, "iterate_kit");
  if (
    config.offset !== release.artifact.configurationPartition.offset ||
    config.size !== release.artifact.configurationPartition.size
  ) {
    throw new Error(
      `${release.artifact.target} configuration partition differs from the reviewed catalog.`,
    );
  }
  const parts = await Promise.all(
    release.artifact.parts.map(async (part) => {
      const bytes = await readFile(join(buildDirectory, part.buildPath));
      return { ...part, sha256: sha256(bytes) };
    }),
  );
  const metadata = {
    sourceFingerprint: fingerprint,
    target: release.artifact.target,
    version: release.version,
    toolchain,
    parts,
  };
  await writeFile(join(directory, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
  return { directory, parts, sourceFingerprint: fingerprint };
}

export async function readFirmwareReleaseBuild(release: EspWebToolsFirmwareRelease) {
  const toolchain = await idfVersion();
  const fingerprint = await sourceFingerprint(toolchain);
  const directory = join(CACHE_ROOT, release.artifact.target, release.version, fingerprint);
  const cached = await readCurrentBuild({
    release,
    directory,
    sourceFingerprint: fingerprint,
    toolchain,
  });
  if (!cached) {
    throw new Error(
      `Firmware cache is missing or stale for ${release.artifact.target}. Run pnpm firmware:release with ESP-IDF active.`,
    );
  }
  return cached;
}

export async function buildAllFirmwareReleases() {
  const releases = firmwareCatalog.flatMap((device) => device.releases);
  for (const release of releases) await buildFirmwareRelease(release);
}

if (process.argv[1]?.endsWith("build-firmware-assets.ts")) {
  await buildAllFirmwareReleases();
}
