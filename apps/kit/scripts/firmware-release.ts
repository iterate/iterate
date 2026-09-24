// apps/kit/scripts/firmware-release.ts — KIT FIRMWARE SHIPS AS PER-DEVICE GITHUB RELEASES, tagged
// `kit-firmware/<device id>/<version>` (catalog.ts `firmwareReleaseTag`, `FIRMWARE_VERSION_PATTERN`).
// Each release carries the build's flash files and a standard esp-web-tools `manifest.json`.
//
// .depot/workflows/kit-firmware.yml drives it:
//   1. `plan` (one job, full history) compares every catalog device's firmware inputs
//      (`firmwareInputs`) with the commit of that device's newest release and prints the build matrix
//      as GITHUB_OUTPUT lines (`planFirmwareReleases`). Any later run (a firmware push, the daily
//      schedule, a dispatch) plans again, so it releases whatever a failed run left behind.
//   2. `build` (one leg per planned device, ESP-IDF active) builds the target with PROJECT_VER set to
//      the version, checks the flash layout against the build's own partition table
//      (`checkFlashLayout`), checks the build read no tracked firmware file outside the device's inputs
//      (`filesOutsideInputs`) and changed no tracked file, then writes the release's files
//      (`buildFirmwareRelease`).
//   3. The workflow's publish job, the only one allowed to write, creates the releases from those files
//      with gh on main, and only lists them anywhere else.
//
//   node apps/kit/scripts/firmware-release.ts plan --devices changed|all --publish true|false [--base <sha>]
//   node apps/kit/scripts/firmware-release.ts build --device <id> [--version dev] [--previous <version>] --out <dir>
//
// It runs under plain `node` (Node 24 strips the types) before anything is installed, so it imports
// only node:* and the catalog.
//
// - PROJECT_VER: https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-reference/system/misc_system_api.html#app-version
// - The binary partition table: https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-guides/partition-tables.html
//   (written by components/partition_table/gen_esp32part.py, `STRUCT_FORMAT = b'<2sBBLL16sL'`)
// - The esp-web-tools manifest: https://esphome.github.io/esp-web-tools/
// - ninja's `-t inputs` and `-t deps`: https://ninja-build.org/manual.html#_extra_tools (ESP-IDF 5.4.2
//   ships ninja 1.12.1)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  FIRMWARE_REPOSITORY,
  FIRMWARE_VERSION_PATTERN,
  findFirmwareDevice,
  firmwareCatalog,
  firmwareReleaseTag,
  type FirmwareDevice,
} from "../src/firmware/catalog.ts";

const FIRMWARE_DIRECTORY = "apps/kit/firmware";

/**
 * A change to either rebuilds every device on a pull request (the builder is not a release input:
 * changing it on main releases nothing until a dispatch with `devices=all`).
 */
const FIRMWARE_BUILDER = [
  "apps/kit/scripts/firmware-release.ts",
  ".depot/workflows/kit-firmware.yml",
];

/** A published release of one device, as `git ls-remote` lists it. */
type FirmwareRelease = { deviceId: string; version: string; commit: string };

/**
 * The version of the checked-out commit (`FIRMWARE_VERSION_PATTERN`): its first-parent commit count,
 * its UTC committer date and its short sha, e.g. `002574-2026-09-23-b2a4558`.
 */
export function firmwareVersion(input: { count: number; date: Date; commit: string }) {
  const count = String(input.count).padStart(6, "0");
  const version = `${count}-${input.date.toISOString().slice(0, 10)}-${input.commit.slice(0, 7)}`;
  if (!FIRMWARE_VERSION_PATTERN.test(version)) {
    throw new Error(`${version} (commit ${input.commit}) does not match FIRMWARE_VERSION_PATTERN.`);
  }
  return version;
}

/**
 * Everything that can change device target `target`'s firmware, as git pathspecs: the firmware tree
 * minus every other board's `devices/<board>` and `targets/<board>` (read from disk, so `mac` and any
 * new board are excluded without a list) and minus what only the host build, the Mac port, the bench
 * tools, the host tests and the docs read. The builder, the catalog, the workflow and the ESP-IDF pin
 * are not inputs: every `targets/<t>/dependencies.lock` records the IDF version, so a new IDF fails
 * the build's clean-tree check until the rewritten locks are committed, and those are inputs.
 *
 * `buildFirmwareRelease` fails when an ESP build reads a tracked firmware file these do not cover, so
 * a wrong exclusion cannot ship a stale release unnoticed.
 */
export function firmwareInputs(repoRoot: string, target: string) {
  const firmware = join(repoRoot, FIRMWARE_DIRECTORY);
  if (!existsSync(join(firmware, "targets", target))) {
    throw new Error(
      `The catalog names target ${target}, but ${FIRMWARE_DIRECTORY}/targets/${target} does not exist.`,
    );
  }
  const otherBoards = new Set(
    ["devices", "targets"].flatMap((parent) =>
      readdirSync(join(firmware, parent), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== target && entry.name !== "common")
        .map((entry) => entry.name),
    ),
  );
  return [
    FIRMWARE_DIRECTORY,
    ...[...otherBoards]
      .sort()
      .flatMap((board) => [
        `:(exclude)${FIRMWARE_DIRECTORY}/devices/${board}`,
        `:(exclude)${FIRMWARE_DIRECTORY}/targets/${board}`,
      ]),
    // the host build (firmware/CMakeLists.txt), the host and Mac platforms, the host tests, and the
    // tools that make bench configuration images and port a board to the Mac
    ...[
      "CMakeLists.txt",
      "platforms/host",
      "platforms/darwin",
      "tests",
      "tools/make-config-image.py",
      "tools/port-for-mac.sh",
    ].map((path) => `:(exclude)${FIRMWARE_DIRECTORY}/${path}`),
    `:(exclude,glob)${FIRMWARE_DIRECTORY}/components/*/tests/**`,
    `:(exclude,glob)${FIRMWARE_DIRECTORY}/**/*.md`,
  ];
}

/**
 * Which devices to build at HEAD of `repoRoot`, checked in this order for each device:
 *
 * 1. `publish` (a main run) and the device's newest release is at or after HEAD's count: skip. Main
 *    is linear, so re-running an old run never publishes an older version as the newest.
 * 2. `force` (`devices=all`): build.
 * 3. No release yet: build.
 * 4. `base` (a pull request's base) and the pull request changed the builder: build.
 * 5. The device's inputs differ between its newest release's commit and HEAD: build.
 * 6. Otherwise skip.
 */
export function planFirmwareReleases(input: {
  repoRoot: string;
  devices: readonly Pick<FirmwareDevice, "id" | "target">[];
  releases: readonly FirmwareRelease[];
  headVersion: string;
  force: boolean;
  publish: boolean;
  base?: string;
}) {
  const { repoRoot, headVersion } = input;
  const builderChanged =
    input.base &&
    gitDiffers(repoRoot, git(repoRoot, "merge-base", input.base, "HEAD"), FIRMWARE_BUILDER);
  const decisions = input.devices.map((device) => {
    const newest = input.releases
      .filter((release) => release.deviceId === device.id)
      .toSorted((left, right) => (left.version < right.version ? -1 : 1))
      .at(-1);
    const previous = newest?.version ?? "";
    const decide = (build: boolean, reason: string) => ({
      device: device.id,
      previous,
      build,
      reason,
    });
    if (
      input.publish &&
      newest &&
      Number(newest.version.slice(0, 6)) >= Number(headVersion.slice(0, 6))
    ) {
      return decide(false, `released at or after this commit (${newest.version})`);
    }
    if (input.force) return decide(true, "forced");
    if (!newest) return decide(true, "first release");
    if (builderChanged) return decide(true, "builder changed on this pull request");
    if (gitDiffers(repoRoot, newest.commit, firmwareInputs(repoRoot, device.target))) {
      return decide(true, `inputs changed since ${newest.version}`);
    }
    return decide(false, `unchanged since ${newest.version}`);
  });
  return {
    build: decisions.filter((decision) => decision.build),
    skip: decisions.filter((decision) => !decision.build),
  };
}

/**
 * The published releases in `git ls-remote --tags` output. An annotated tag's peeled `^{}` line names
 * its commit. Any other `kit-firmware/` ref (a malformed or hand-made tag) is skipped with a warning,
 * so it can never become a device's newest release.
 */
export function releasesFromRefs(lsRemote: string) {
  const releases = new Map<string, FirmwareRelease>();
  for (const line of lsRemote.split("\n")) {
    const [commit, ref] = line.split("\t");
    if (!commit || !ref?.startsWith("refs/tags/kit-firmware/")) continue;
    const tag = ref.slice("refs/tags/".length).replace(/\^\{\}$/, "");
    const [, deviceId, version, ...rest] = tag.split("/");
    if (!deviceId || !version || rest.length > 0 || !FIRMWARE_VERSION_PATTERN.test(version)) {
      console.warn(`Ignoring ${ref}: not kit-firmware/<device id>/<version>.`);
      continue;
    }
    // the peeled line follows its tag's, so it wins
    releases.set(tag, { deviceId, version, commit });
  }
  return [...releases.values()];
}

/**
 * The entries of an ESP-IDF binary partition table: 32-byte records (magic `AA 50`, type, subtype,
 * little-endian offset and size, a NUL-padded 16-byte label, flags) up to the first record without the
 * magic, which is the `EB EB` MD5 row or the `FF` padding.
 */
export function readPartitionTable(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const partitions = [];
  for (let cursor = 0; cursor + 32 <= bytes.byteLength; cursor += 32) {
    if (view.getUint16(cursor, true) !== 0x50aa) break;
    const label = bytes.subarray(cursor + 12, cursor + 28);
    partitions.push({
      type: view.getUint8(cursor + 2),
      subtype: view.getUint8(cursor + 3),
      offset: view.getUint32(cursor + 4, true),
      size: view.getUint32(cursor + 8, true),
      label: new TextDecoder().decode(label.subarray(0, label.includes(0) ? label.indexOf(0) : 16)),
    });
  }
  if (partitions.length === 0) throw new Error("The partition table has no entries.");
  return partitions;
}

/**
 * Checks a build's flash files against the build's own partition table, and returns the
 * configuration partition Kit writes each install's `ITERKIT1` image to (type 0x40, subtype 0x00,
 * label `iterate_kit`, which platforms/iterate_esp_idf/configuration.c finds). A release that passes
 * can be flashed as a whole without touching that partition:
 *
 * - file names are unique (release assets are flat);
 * - one file is written at offset 0 (the bootloader) and one is `partition-table.bin`;
 * - every other file lies wholly inside a partition other than the configuration partition;
 * - no two files overlap, and no file overlaps the configuration partition;
 * - when there is an otadata partition, a file initialises it (`ota_data_initial.bin` resets the boot
 *   slot to ota_0, so a flash never boots an older image left in ota_1);
 * - every file and the configuration partition end within the flash size.
 */
export function checkFlashLayout(input: {
  parts: readonly FlashPart[];
  partitions: readonly Partition[];
  flashSize: number;
}) {
  const { parts, partitions, flashSize } = input;
  const files = parts.map((part) => part.file);
  const duplicate = files.find((file, index) => files.indexOf(file) !== index);
  if (duplicate) throw new Error(`Two flash files are named ${duplicate}.`);
  if (!parts.some((part) => part.offset === 0)) {
    throw new Error("No flash file is written at offset 0, where the bootloader goes.");
  }
  const table = parts.find((part) => part.file === "partition-table.bin");
  if (!table) throw new Error("The flash files have no partition-table.bin.");

  const configurations = partitions.filter(
    (partition) =>
      partition.type === 0x40 && partition.subtype === 0 && partition.label === "iterate_kit",
  );
  if (configurations.length !== 1) {
    throw new Error(
      `Expected one iterate_kit partition (type 0x40, subtype 0x00), found ${configurations.length}.`,
    );
  }
  const configuration = configurations[0]!;
  const describe = (region: Region) =>
    `0x${region.offset.toString(16)}+0x${region.size.toString(16)}`;

  for (const part of parts) {
    if (overlaps(part, configuration)) {
      throw new Error(
        `${part.file} (${describe(part)}) overlaps the iterate_kit partition (${describe(configuration)}).`,
      );
    }
    if (
      part.offset !== 0 &&
      part !== table &&
      !partitions.some((partition) => contains(partition, part))
    ) {
      throw new Error(`${part.file} (${describe(part)}) lies in no partition.`);
    }
    if (part.offset + part.size > flashSize) {
      throw new Error(`${part.file} (${describe(part)}) ends beyond the ${flashSize}-byte flash.`);
    }
  }
  const sorted = parts.toSorted((left, right) => left.offset - right.offset);
  for (const [index, part] of sorted.entries()) {
    const next = sorted[index + 1];
    if (next && overlaps(part, next)) {
      throw new Error(
        `${part.file} (${describe(part)}) overlaps ${next.file} (${describe(next)}).`,
      );
    }
  }
  const otadata = partitions.find(
    (partition) => partition.type === 0x01 && partition.subtype === 0x00,
  );
  if (otadata && !parts.some((part) => contains(otadata, part))) {
    throw new Error(`No flash file initialises the otadata partition (${describe(otadata)}).`);
  }
  if (configuration.offset + configuration.size > flashSize) {
    throw new Error(
      `The iterate_kit partition (${describe(configuration)}) ends beyond the ${flashSize}-byte flash.`,
    );
  }
  return { offset: configuration.offset, size: configuration.size };
}

/** One entry of an ESP-IDF binary partition table. */
type Partition = ReturnType<typeof readPartitionTable>[number];

/**
 * A release's `manifest.json`: a standard esp-web-tools manifest (https://esphome.github.io/esp-web-tools/)
 * whose part paths are relative to the manifest, plus `configurationPartition`, the region Kit fills
 * with the install's configuration image at flash time. Kit also adds the device's current name and
 * its install options then, so a renamed device still flashes its old releases.
 *
 * There is no `configurationFormat` field while `ITERKIT1` is the only configuration format; a firmware
 * change that needs a new one adds it (apps/kit/firmware/AGENTS.md).
 */
export function firmwareManifest(input: {
  device: FirmwareDevice;
  version: string;
  /** esptool's chip name, from flasher_args.json `extra_esptool_args.chip`. */
  chip: string;
  parts: readonly Omit<FlashPart, "size">[];
  configurationPartition: Region;
}) {
  if (input.chip !== "esp32s3") {
    throw new Error(`Kit releases only ESP32-S3 firmware; this build is for ${input.chip}.`);
  }
  return {
    name: input.device.name,
    version: input.version,
    builds: [
      {
        chipFamily: "ESP32-S3", // esp-web-tools' name for esptool's esp32s3
        parts: input.parts
          .toSorted((left, right) => left.offset - right.offset)
          .map((part) => ({ path: `./${part.file}`, offset: part.offset })),
      },
    ],
    configurationPartition: input.configurationPartition,
  };
}

/**
 * Every file a finished ninja build read, as absolute paths. `ninja -t inputs all build.ninja` lists
 * the graph's inputs, which include custom-command DEPENDS and the CMake files `build.ninja` is
 * regenerated from, one per line and shell-quoted when needed (`'a b'`, `'it'\''s'`). `ninja -t deps`
 * lists the headers each compile reported, indented four spaces under the object they built. Relative
 * paths are relative to the build directory.
 */
export function ninjaPaths(input: { directory: string; inputs: string; deps: string }) {
  const listed = input.inputs
    .split("\n")
    .filter(Boolean)
    .map((line) =>
      line.startsWith("'") && line.endsWith("'")
        ? line.slice(1, -1).replaceAll("'\\''", "'")
        : line,
    );
  const reported = input.deps
    .split("\n")
    .filter((line) => line.startsWith("    "))
    .map((line) => line.slice(4));
  return new Set([...listed, ...reported].map((path) => resolve(input.directory, path)));
}

/**
 * The tracked firmware files a build read that its device's inputs do not cover, sorted. `read`,
 * `tracked` (`git ls-files apps/kit/firmware`) and `covered` (`git ls-files <firmwareInputs>`) are
 * repository-relative, so untracked and generated files never count.
 */
export function filesOutsideInputs(input: {
  read: Iterable<string>;
  tracked: ReadonlySet<string>;
  covered: ReadonlySet<string>;
}) {
  return [...new Set(input.read)]
    .filter((file) => input.tracked.has(file) && !input.covered.has(file))
    .sort();
}

/**
 * Builds `device` at HEAD of `repoRoot` into `<out>/build` and, once every check passes, writes the
 * release into `<out>/release`: `assets/` (the flash files and `manifest.json`), `release.json`
 * (`{ tag, title }` for gh) and `notes.md`. ESP-IDF must be active (`source $IDF_PATH/export.sh`).
 * `version` is the planned version, or `dev` for a bench build; `previous` is the device's newest
 * release, or empty.
 */
export function buildFirmwareRelease(input: {
  repoRoot: string;
  device: FirmwareDevice;
  version: string;
  previous: string;
  out: string;
}) {
  const { repoRoot, device, version, previous, out } = input;
  const head = git(repoRoot, "rev-parse", "HEAD");
  if (
    version !== "dev" &&
    !(FIRMWARE_VERSION_PATTERN.test(version) && head.startsWith(version.slice(-7)))
  ) {
    throw new Error(`Version ${version} was not planned for this checkout (${head}).`);
  }
  const treeBefore = firmwareTreeStatus(repoRoot);
  const app = join(repoRoot, "apps/kit");
  const build = join(out, "build");
  // the avatar atlases are generated and gitignored (components/avatar/src/.gitignore)
  run("python3", ["firmware/tools/generate-atlases.py"], app);
  run(
    "idf.py",
    [
      ...["-C", `firmware/targets/${device.target}`, "-B", build],
      ...["-D", "IDF_TARGET=esp32s3", "-D", `SDKCONFIG=${join(out, "sdkconfig")}`],
      ...["-D", `PROJECT_VER=${version}`, "build"],
    ],
    app,
  );

  // Written by ESP-IDF's own build (tools/cmake/project_description.json.in); a different shape
  // fails the comparison below.
  const description = JSON.parse(readFileSync(join(build, "project_description.json"), "utf8")) as {
    project_version: string;
    git_revision: string;
  };
  if (description.project_version !== version) {
    throw new Error(
      `The build's project_version is ${description.project_version}, not ${version}.`,
    );
  }
  const flasher = readFlasherArgs(join(build, "flasher_args.json"));
  const parts = flasher.files.map(({ offset, path }) => ({
    file: basename(path),
    offset,
    size: statSync(join(build, path)).size,
    source: join(build, path),
  }));
  const configurationPartition = checkFlashLayout({
    parts,
    partitions: readPartitionTable(
      readFileSync(join(build, "partition_table", "partition-table.bin")),
    ),
    flashSize: flasher.flashSize,
  });

  const read = [build, join(build, "bootloader")]
    .filter((directory) => existsSync(join(directory, "build.ninja")))
    .flatMap((directory) => [
      ...ninjaPaths({
        directory,
        inputs: output("ninja", ["-C", directory, "-t", "inputs", "all", "build.ninja"], repoRoot),
        deps: output("ninja", ["-C", directory, "-t", "deps"], repoRoot),
      }),
    ])
    .map((path) => relative(repoRoot, path));
  const outside = filesOutsideInputs({
    read,
    tracked: new Set(gitFiles(repoRoot, [FIRMWARE_DIRECTORY])),
    covered: new Set(gitFiles(repoRoot, firmwareInputs(repoRoot, device.target))),
  });
  if (outside.length > 0) {
    throw new Error(
      [
        `The ${device.target} build read tracked files outside its inputs, so a change to them would not release it:`,
        ...outside.map((file) => `  ${file}`),
        "Widen `firmwareInputs` in apps/kit/scripts/firmware-release.ts, or stop reading them.",
      ].join("\n"),
    );
  }
  const ownFiles = read.filter((file) => file.startsWith(`${FIRMWARE_DIRECTORY}/`));
  // a path mismatch between ninja and git would otherwise make the check vacuous
  if (!ownFiles.includes(`${FIRMWARE_DIRECTORY}/targets/${device.target}/CMakeLists.txt`)) {
    throw new Error(
      `ninja listed none of ${FIRMWARE_DIRECTORY}/targets/${device.target}; the input check proves nothing.`,
    );
  }
  console.log(
    `${device.target}: ${new Set(ownFiles).size} firmware files read, all inside its inputs.`,
  );

  const treeAfter = firmwareTreeStatus(repoRoot);
  if (treeAfter !== treeBefore) {
    run("git", ["diff", "--", FIRMWARE_DIRECTORY], repoRoot);
    throw new Error(
      `The build changed the firmware tree (commit what it rewrote, e.g. a dependencies.lock, or ignore what it generates):\nbefore:\n${treeBefore}\nafter:\n${treeAfter}`,
    );
  }

  const release = join(out, "release");
  const assets = join(release, "assets");
  rmSync(release, { recursive: true, force: true });
  mkdirSync(assets, { recursive: true });
  for (const part of parts) copyFileSync(part.source, join(assets, part.file));
  const manifest = firmwareManifest({
    device,
    version,
    chip: flasher.chip,
    parts,
    configurationPartition,
  });
  writeFileSync(join(assets, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(release, "release.json"),
    `${JSON.stringify({ tag: firmwareReleaseTag(device.id, version), title: `${device.name} firmware ${version}` }, null, 2)}\n`,
  );
  writeFileSync(
    join(release, "notes.md"),
    [
      `${device.name} (\`${device.id}\`) firmware ${version}, built from ${head} with ESP-IDF ${description.git_revision}.`,
      "",
      previous
        ? `Changes since ${previous}: https://github.com/${FIRMWARE_REPOSITORY}/compare/${previous.slice(-7)}...${head}`
        : "First release for this device.",
      "",
    ].join("\n"),
  );

  console.log(["file", "offset", "size", "sha256"].join("\t"));
  for (const { file, offset } of [...parts, { file: "manifest.json", offset: -1 }]) {
    const bytes = readFileSync(join(assets, file));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    console.log(
      [file, offset < 0 ? "-" : `0x${offset.toString(16)}`, bytes.byteLength, sha256].join("\t"),
    );
  }
}

/** A file the build writes to flash. */
type FlashPart = { file: string; offset: number; size: number };

/** A region of flash. */
type Region = { offset: number; size: number };

function contains(region: Region, part: Region) {
  return part.offset >= region.offset && part.offset + part.size <= region.offset + region.size;
}

function overlaps(left: Region, right: Region) {
  return left.offset < right.offset + right.size && right.offset < left.offset + left.size;
}

/**
 * What the release needs from ESP-IDF's `build/flasher_args.json` (the file `idf.py flash` reads):
 * the flash files by offset, the flash size and esptool's chip name.
 */
function readFlasherArgs(path: string) {
  // Written by ESP-IDF's own build (tools/cmake/flasher_args.json.in); each field is checked below.
  const flasher = JSON.parse(readFileSync(path, "utf8")) as {
    flash_files: Record<string, string>;
    flash_settings: { flash_size: string };
    extra_esptool_args: { chip: string };
  };
  const megabytes = /^(\d+)MB$/.exec(flasher.flash_settings.flash_size)?.[1];
  if (!megabytes)
    throw new Error(`${path} has flash_size ${flasher.flash_settings.flash_size}, not <n>MB.`);
  const files = Object.entries(flasher.flash_files).map(([offset, file]) => {
    if (!/^0x[0-9a-f]+$/i.test(offset)) throw new Error(`${path} writes ${file} at ${offset}.`);
    return { offset: Number.parseInt(offset, 16), path: file };
  });
  if (!flasher.extra_esptool_args.chip) throw new Error(`${path} names no chip.`);
  return {
    files,
    flashSize: Number(megabytes) * 1024 * 1024,
    chip: flasher.extra_esptool_args.chip,
  };
}

/** `git status` of the firmware tree, untracked files included. */
function firmwareTreeStatus(repoRoot: string) {
  return output(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--", FIRMWARE_DIRECTORY],
    repoRoot,
  );
}

function gitFiles(repoRoot: string, pathspecs: readonly string[]) {
  return output("git", ["ls-files", "-z", "--", ...pathspecs], repoRoot)
    .split("\0")
    .filter(Boolean);
}

function git(repoRoot: string, ...args: string[]) {
  return output("git", args, repoRoot).trim();
}

/** Whether `pathspecs` differ between `commit` and HEAD (`git diff --quiet` exits 1). */
function gitDiffers(repoRoot: string, commit: string, pathspecs: readonly string[]) {
  const result = spawnSync("git", ["diff", "--quiet", commit, "HEAD", "--", ...pathspecs], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status === 0 || result.status === 1) return result.status === 1;
  throw new Error(
    `git diff ${commit} HEAD exited ${result.status ?? result.signal}: ${result.stderr}`,
  );
}

/** Runs a command with its output in the log. */
function run(command: string, args: readonly string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? result.signal}.`);
}

/** Runs a command and returns its stdout; ninja's input lists run to megabytes. */
function output(command: string, args: readonly string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? result.signal}.`);
  return result.stdout;
}

if (process.argv[1]?.endsWith("firmware-release.ts")) {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      devices: { type: "string", default: "changed" },
      publish: { type: "string", default: "false" },
      base: { type: "string", default: "" },
      device: { type: "string", default: "" },
      version: { type: "string", default: "dev" },
      previous: { type: "string", default: "" },
      out: { type: "string", default: "" },
    },
  });
  if (positionals[0] === "plan") {
    if (!["changed", "all"].includes(values.devices))
      throw new Error("--devices is changed or all.");
    if (!["true", "false"].includes(values.publish)) throw new Error("--publish is true or false.");
    // the version counts first-parent commits, and the diffs reach back to each device's last release
    if (git(repoRoot, "rev-parse", "--is-shallow-repository") !== "false") {
      throw new Error("plan needs the full history (actions/checkout fetch-depth: 0).");
    }
    const head = git(repoRoot, "rev-parse", "HEAD");
    const headVersion = firmwareVersion({
      count: Number(git(repoRoot, "rev-list", "--count", "--first-parent", "HEAD")),
      date: new Date(Number(git(repoRoot, "log", "-1", "--format=%ct", "HEAD")) * 1000),
      commit: head,
    });
    const plan = planFirmwareReleases({
      repoRoot,
      devices: firmwareCatalog,
      // anonymous against the public repository, and never stale like the checkout's own tags
      releases: releasesFromRefs(output("git", ["ls-remote", "--tags", "origin"], repoRoot)),
      headVersion,
      force: values.devices === "all",
      publish: values.publish === "true",
      base: values.base,
    });
    console.error(`Firmware ${headVersion} at ${head}:`);
    for (const { device, reason } of plan.build) console.error(`  build ${device}: ${reason}`);
    for (const { device, reason } of plan.skip) console.error(`  skip ${device}: ${reason}`);
    // stdout is GITHUB_OUTPUT
    const matrix = { include: plan.build.map(({ device, previous }) => ({ device, previous })) };
    process.stdout.write(
      `version=${headVersion}\ncount=${plan.build.length}\nmatrix=${JSON.stringify(matrix)}\n`,
    );
  } else if (positionals[0] === "build") {
    const device = findFirmwareDevice(values.device);
    if (!device) throw new Error(`--device must be a catalog id, not "${values.device}".`);
    if (!values.out)
      throw new Error("--out names the directory for the build and the release files.");
    buildFirmwareRelease({
      repoRoot,
      device,
      version: values.version,
      previous: values.previous,
      out: resolve(values.out),
    });
  } else {
    throw new Error("Usage: firmware-release.ts plan|build (see the top of the file).");
  }
}
