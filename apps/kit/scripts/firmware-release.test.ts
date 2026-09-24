import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { FIRMWARE_VERSION_PATTERN, findFirmwareDevice } from "../src/firmware/catalog.ts";
import {
  checkFlashLayout,
  filesOutsideInputs,
  firmwareInputs,
  firmwareManifest,
  firmwareVersion,
  ninjaPaths,
  planFirmwareReleases,
  readPartitionTable,
  releasesFromRefs,
} from "./firmware-release.ts";

test("firmwareVersion: the zero-padded first-parent count, the UTC date and the short sha", () => {
  const version = firmwareVersion({
    count: 2574,
    date: new Date("2026-09-23T23:59:59Z"),
    commit: "b2a455881c0ffee0000000000000000000000000",
  });

  expect(version).toBe("002574-2026-09-23-b2a4558");
  expect(version).toMatch(FIRMWARE_VERSION_PATTERN);
  // esp_app_desc_t.version holds 31 characters
  expect(version.length).toBeLessThanOrEqual(31);
});

test("firmwareVersion: refuses a count that would no longer sort as a string", () => {
  expect(() => firmwareVersion({ count: 1_000_000, date: new Date(0), commit: "b2a4558" })).toThrow(
    /FIRMWARE_VERSION_PATTERN/,
  );
});

// ── planFirmwareReleases, on a fixture repository with boards a, b and mac ──

test("plan: a device that has never been released is built", () => {
  using repo = firmwareRepository();

  expect(summary(repo.plan({ releases: [] }))).toEqual([
    "build device-a: first release",
    "build device-b: first release",
  ]);
});

test("plan: a change to one board's own directory builds only that board", () => {
  using repo = firmwareRepository();
  const releases = repo.releaseAll();
  repo.commit({ "apps/kit/firmware/devices/a/board.c": "changed" });
  const plan = repo.plan({ releases });

  expect(summary(plan)).toEqual([
    `build device-a: inputs changed since ${releases[0]!.version}`,
    `skip device-b: unchanged since ${releases[1]!.version}`,
  ]);
  expect(plan).toMatchObject({ build: [{ device: "device-a", previous: releases[0]!.version }] });
});

test.for([
  "apps/kit/firmware/targets/common/sdkconfig.defaults",
  "apps/kit/firmware/components/x/src/x.c",
])("plan: a change to shared code (%s) builds every board", (file) => {
  using repo = firmwareRepository();
  const releases = repo.releaseAll();
  repo.commit({ [file]: "changed" });

  expect(summary(repo.plan({ releases }))).toEqual([
    `build device-a: inputs changed since ${releases[0]!.version}`,
    `build device-b: inputs changed since ${releases[1]!.version}`,
  ]);
});

test.for([
  "apps/kit/firmware/devices/b/board.c",
  "apps/kit/firmware/targets/b/CMakeLists.txt",
  "apps/kit/firmware/devices/mac/board.c",
  "apps/kit/firmware/CMakeLists.txt",
  "apps/kit/firmware/platforms/host/esp_idf.c",
  "apps/kit/firmware/tests/board_test.c",
  "apps/kit/firmware/components/x/tests/x_test.c",
  "apps/kit/firmware/README.md",
  "apps/kit/firmware/devices/a/notes.md",
])("plan: a change to %s does not build board a", (file) => {
  using repo = firmwareRepository();
  const releases = repo.releaseAll();
  repo.commit({ [file]: "changed" });

  expect(summary(repo.plan({ releases }))).toContain(
    `skip device-a: unchanged since ${releases[0]!.version}`,
  );
});

test("plan: devices=all builds every board", () => {
  using repo = firmwareRepository();

  expect(summary(repo.plan({ releases: repo.releaseAll(), force: true }))).toEqual([
    "build device-a: forced",
    "build device-b: forced",
  ]);
});

test("plan: a main run never releases at or behind a device's newest release, even when forced", () => {
  using repo = firmwareRepository();
  const old = repo.head();
  repo.commit({ "apps/kit/firmware/devices/a/board.c": "newer" });
  const releases = repo.releaseAll();
  const skipped = [
    `skip device-a: released at or after this commit (${releases[0]!.version})`,
    `skip device-b: released at or after this commit (${releases[1]!.version})`,
  ];

  // re-running an old main run: its head is behind both releases
  expect(
    summary(repo.plan({ releases, publish: true, force: true, headVersion: repo.version(old) })),
  ).toEqual(skipped);
  // the run that published them, again
  expect(summary(repo.plan({ releases, publish: true }))).toEqual(skipped);
});

test("plan: a pull request that changes the builder builds every board", () => {
  using repo = firmwareRepository();
  const releases = repo.releaseAll();
  const base = repo.head();
  repo.commit({ "apps/kit/scripts/firmware-release.ts": "// changed" });

  expect(summary(repo.plan({ releases, base }))).toEqual([
    "build device-a: builder changed on this pull request",
    "build device-b: builder changed on this pull request",
  ]);
  // the builder is not a release input
  expect(summary(repo.plan({ releases, base: repo.head() }))).toEqual([
    `skip device-a: unchanged since ${releases[0]!.version}`,
    `skip device-b: unchanged since ${releases[1]!.version}`,
  ]);
});

test("plan: each device is compared with its newest release", () => {
  using repo = firmwareRepository();
  const first = repo.releaseAll();
  repo.commit({ "apps/kit/firmware/devices/a/board.c": "released later" });
  const newer = { ...first[0]!, version: repo.version(repo.head()), commit: repo.head() };

  expect(summary(repo.plan({ releases: [newer, ...first] }))).toEqual([
    `skip device-a: unchanged since ${newer.version}`,
    `skip device-b: unchanged since ${first[1]!.version}`,
  ]);
});

test("firmwareInputs: excludes every other board, the Mac included, and what only the host build reads", () => {
  const repoRoot = join(import.meta.dirname, "../../..");
  const inputs = firmwareInputs(repoRoot, "havpe");

  expect(inputs).toEqual(
    expect.arrayContaining([
      "apps/kit/firmware",
      ":(exclude)apps/kit/firmware/devices/mac",
      ":(exclude)apps/kit/firmware/targets/mac",
      ":(exclude)apps/kit/firmware/devices/satellite1",
      ":(exclude)apps/kit/firmware/platforms/host",
      ":(exclude,glob)apps/kit/firmware/**/*.md",
    ]),
  );
  expect(inputs.join("\n")).not.toMatch(/\/(devices|targets)\/(havpe|common)$/m);
  expect(() => firmwareInputs(repoRoot, "no_such_board")).toThrow(/targets\/no_such_board/);
});

test("releasesFromRefs: reads kit-firmware tags, peels annotated ones and skips malformed ones", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());
  const refs = [
    "1111111111111111111111111111111111111111\trefs/tags/kit-firmware/satellite1/002574-2026-09-23-b2a4558",
    "2222222222222222222222222222222222222222\trefs/tags/kit-firmware/stackchan/002575-2026-09-24-c3b5669",
    "3333333333333333333333333333333333333333\trefs/tags/kit-firmware/stackchan/002575-2026-09-24-c3b5669^{}",
    "4444444444444444444444444444444444444444\trefs/tags/kit-firmware/stackchan/latest",
    "5555555555555555555555555555555555555555\trefs/tags/kit-firmware/stackchan",
    "6666666666666666666666666666666666666666\trefs/tags/v2026-09-23-20-00-01",
    "",
  ].join("\n");

  expect(releasesFromRefs(refs)).toEqual([
    {
      deviceId: "satellite1",
      version: "002574-2026-09-23-b2a4558",
      commit: "1111111111111111111111111111111111111111",
    },
    {
      deviceId: "stackchan",
      version: "002575-2026-09-24-c3b5669",
      commit: "3333333333333333333333333333333333333333",
    },
  ]);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith(
    "Ignoring refs/tags/kit-firmware/stackchan/latest: not kit-firmware/<device id>/<version>.",
  );
  expect(warn).toHaveBeenCalledWith(
    "Ignoring refs/tags/kit-firmware/stackchan: not kit-firmware/<device id>/<version>.",
  );
});

// ── readPartitionTable and checkFlashLayout, on havpe's table and production sizes ──

// the production havpe release's sizes
const havpeParts = [
  { file: "bootloader.bin", offset: 0, size: 20_480 },
  { file: "partition-table.bin", offset: 0x8000, size: 3072 },
  { file: "iterate-kit-havpe.bin", offset: 0x10000, size: 1_257_808 },
  { file: "ota_data_initial.bin", offset: 0x511000, size: 8192 },
  { file: "srmodels.bin", offset: 0xa20000, size: 291_168 },
];

test("readPartitionTable: every entry up to the MD5 row", () => {
  expect(readPartitionTable(havpeTable())).toEqual([
    { label: "nvs", type: 0x01, subtype: 0x02, offset: 0x9000, size: 0x6000 },
    { label: "phy_init", type: 0x01, subtype: 0x01, offset: 0xf000, size: 0x1000 },
    { label: "ota_0", type: 0x00, subtype: 0x10, offset: 0x10000, size: 0x500000 },
    { label: "iterate_kit", type: 0x40, subtype: 0x00, offset: 0x510000, size: 0x1000 },
    { label: "otadata", type: 0x01, subtype: 0x00, offset: 0x511000, size: 0x2000 },
    { label: "ota_1", type: 0x00, subtype: 0x11, offset: 0x520000, size: 0x500000 },
    { label: "model", type: 0x01, subtype: 0x82, offset: 0xa20000, size: 0x400000 },
  ]);
});

test("checkFlashLayout: accepts the havpe layout and returns its configuration partition", () => {
  expect(
    checkFlashLayout({
      parts: havpeParts,
      partitions: readPartitionTable(havpeTable()),
      flashSize: 16 * 1024 * 1024,
    }),
  ).toEqual({ offset: 0x510000, size: 0x1000 });
});

test.for([
  {
    problem: "two files with one name",
    parts: [...havpeParts, { file: "bootloader.bin", offset: 0x9000, size: 16 }],
    error: /Two flash files are named bootloader.bin/,
  },
  {
    problem: "overlapping files",
    parts: [...havpeParts, { file: "extra.bin", offset: 0x11000, size: 16 }],
    error: /iterate-kit-havpe.bin \(0x10000\+0x133150\) overlaps extra.bin/,
  },
  {
    problem: "a file inside iterate_kit",
    parts: [...havpeParts, { file: "config.bin", offset: 0x510800, size: 16 }],
    error: /config.bin \(0x510800\+0x10\) overlaps the iterate_kit partition/,
  },
  {
    problem: "a file outside every partition",
    parts: [...havpeParts, { file: "stray.bin", offset: 0xf00000, size: 16 }],
    error: /stray.bin \(0xf00000\+0x10\) lies in no partition/,
  },
  {
    problem: "an app larger than its slot",
    parts: havpeParts.map((part) =>
      part.file === "iterate-kit-havpe.bin" ? { ...part, size: 0x500001 } : part,
    ),
    error: /iterate-kit-havpe.bin \(0x10000\+0x500001\) overlaps the iterate_kit partition/,
  },
  {
    problem: "no file for otadata",
    parts: havpeParts.filter((part) => part.file !== "ota_data_initial.bin"),
    error: /No flash file initialises the otadata partition/,
  },
  {
    problem: "no bootloader",
    parts: havpeParts.filter((part) => part.offset !== 0),
    error: /offset 0/,
  },
  {
    problem: "no partition table",
    parts: havpeParts.filter((part) => part.file !== "partition-table.bin"),
    error: /no partition-table.bin/,
  },
  {
    problem: "a file beyond the flash size",
    parts: havpeParts,
    flashSize: 8 * 1024 * 1024,
    error: /srmodels.bin \(0xa20000\+0x47160\) ends beyond the 8388608-byte flash/,
  },
])("checkFlashLayout: rejects $problem", ({ parts, flashSize = 16 * 1024 * 1024, error }) => {
  expect(() =>
    checkFlashLayout({ parts, partitions: readPartitionTable(havpeTable()), flashSize }),
  ).toThrow(error);
});

test("checkFlashLayout: rejects a table without exactly one iterate_kit partition", () => {
  const partitions = readPartitionTable(havpeTable());
  const tables = [
    partitions.filter(({ label }) => label !== "iterate_kit"),
    partitions.map((partition) =>
      partition.label === "iterate_kit" ? { ...partition, label: "config" } : partition,
    ),
    [...partitions, partitions[3]!],
  ];

  for (const table of tables) {
    expect(() =>
      checkFlashLayout({ parts: havpeParts, partitions: table, flashSize: 16 * 1024 * 1024 }),
    ).toThrow(/Expected one iterate_kit partition/);
  }
});

test("firmwareManifest: an esp-web-tools manifest with relative part paths, sorted by offset", () => {
  expect(
    firmwareManifest({
      device: findFirmwareDevice("home-assistant-voice-preview-edition")!,
      version: "002574-2026-09-23-b2a4558",
      chip: "esp32s3",
      parts: [
        { file: "srmodels.bin", offset: 0xa20000 },
        { file: "bootloader.bin", offset: 0 },
        { file: "iterate-kit-havpe.bin", offset: 0x10000 },
        { file: "partition-table.bin", offset: 0x8000 },
        { file: "ota_data_initial.bin", offset: 0x511000 },
      ],
      configurationPartition: { offset: 0x510000, size: 0x1000 },
    }),
  ).toEqual({
    name: "Home Assistant Voice Preview Edition",
    version: "002574-2026-09-23-b2a4558",
    builds: [
      {
        chipFamily: "ESP32-S3",
        parts: [
          { path: "./bootloader.bin", offset: 0 },
          { path: "./partition-table.bin", offset: 32768 },
          { path: "./iterate-kit-havpe.bin", offset: 65536 },
          { path: "./ota_data_initial.bin", offset: 5312512 },
          { path: "./srmodels.bin", offset: 10616832 },
        ],
      },
    ],
    configurationPartition: { offset: 5308416, size: 4096 },
  });
});

test("firmwareManifest: refuses a chip other than the ESP32-S3", () => {
  expect(() =>
    firmwareManifest({
      device: findFirmwareDevice("home-assistant-voice-preview-edition")!,
      version: "002574-2026-09-23-b2a4558",
      chip: "esp32c3",
      parts: [{ file: "bootloader.bin", offset: 0 }],
      configurationPartition: { offset: 0x510000, size: 0x1000 },
    }),
  ).toThrow(/this build is for esp32c3/);
});

// ── ninjaPaths and filesOutsideInputs, on ninja 1.12's output ──

const ninjaOutput = {
  directory: "/tmp/kit-firmware/build",
  // `ninja -t inputs all`: sorted, shell-quoted when needed
  inputs: [
    "../../../work/iterate/apps/kit/firmware/components/core/src/core.c",
    "/work/iterate/apps/kit/firmware/devices/havpe/assets/call_ended.wav",
    "'/work/iterate/apps/kit/firmware/devices/satellite1/it'\\''s here.c'",
    "/work/iterate/apps/kit/firmware/targets/stackchan/CMakeLists.txt",
    "/opt/esp-idf/components/esp_system/startup.c",
    "esp-idf/avatar/generated-sounds/sounds_generated.inc",
    "",
  ].join("\n"),
  // `ninja -t query build.ninja`: the CMake files build.ninja is regenerated from
  regeneration: [
    "build.ninja:",
    "  input: RERUN_CMAKE",
    "    | /work/iterate/apps/kit/firmware/targets/stackchan/CMakeLists.txt",
    "    | /work/iterate/apps/kit/firmware/targets/common/components.cmake",
    "    || /work/iterate/apps/kit/firmware/devices/zectrix_note4/extra.cmake",
    "  outputs:",
    "    all",
    "",
  ].join("\n"),
  // `ninja -t deps`: each object's headers, indented four spaces
  deps: [
    "esp-idf/core/CMakeFiles/__idf_core.dir/src/core.c.obj: #deps 2, deps mtime 1727136000 (VALID)",
    "    /work/iterate/apps/kit/firmware/components/core/include/iterate/kit/core.h",
    "    /work/iterate/apps/kit/firmware/platforms/host/include/esp_log.h",
    "",
  ].join("\n"),
};

test("ninjaPaths: every listed and reported path, resolved against the build directory", () => {
  expect([...ninjaPaths(ninjaOutput)].sort()).toEqual([
    "/opt/esp-idf/components/esp_system/startup.c",
    "/tmp/kit-firmware/build/esp-idf/avatar/generated-sounds/sounds_generated.inc",
    "/work/iterate/apps/kit/firmware/components/core/include/iterate/kit/core.h",
    "/work/iterate/apps/kit/firmware/components/core/src/core.c",
    "/work/iterate/apps/kit/firmware/devices/havpe/assets/call_ended.wav",
    "/work/iterate/apps/kit/firmware/devices/satellite1/it's here.c",
    "/work/iterate/apps/kit/firmware/devices/zectrix_note4/extra.cmake",
    "/work/iterate/apps/kit/firmware/platforms/host/include/esp_log.h",
    "/work/iterate/apps/kit/firmware/targets/common/components.cmake",
    "/work/iterate/apps/kit/firmware/targets/stackchan/CMakeLists.txt",
  ]);
});

test("filesOutsideInputs: tracked files outside the device's inputs, never untracked or generated ones", () => {
  const read = [...ninjaPaths(ninjaOutput)].map((path) => relative("/work/iterate", path));
  const tracked = new Set([
    "apps/kit/firmware/components/core/src/core.c",
    "apps/kit/firmware/components/core/include/iterate/kit/core.h",
    "apps/kit/firmware/devices/havpe/assets/call_ended.wav",
    "apps/kit/firmware/devices/satellite1/it's here.c",
    "apps/kit/firmware/devices/zectrix_note4/extra.cmake",
    "apps/kit/firmware/platforms/host/include/esp_log.h",
    "apps/kit/firmware/targets/common/components.cmake",
    "apps/kit/firmware/targets/stackchan/CMakeLists.txt",
  ]);
  // stackchan's inputs: everything but the other boards and the host platform
  const covered = new Set([
    "apps/kit/firmware/components/core/src/core.c",
    "apps/kit/firmware/components/core/include/iterate/kit/core.h",
    "apps/kit/firmware/targets/common/components.cmake",
    "apps/kit/firmware/targets/stackchan/CMakeLists.txt",
  ]);

  expect(filesOutsideInputs({ read, tracked, covered })).toEqual([
    "apps/kit/firmware/devices/havpe/assets/call_ended.wav",
    "apps/kit/firmware/devices/satellite1/it's here.c",
    "apps/kit/firmware/devices/zectrix_note4/extra.cmake",
    "apps/kit/firmware/platforms/host/include/esp_log.h",
  ]);
});

/** One line per device, sorted: `build <id>: <reason>` or `skip <id>: <reason>`. */
function summary(plan: ReturnType<typeof planFirmwareReleases>) {
  return [...plan.build, ...plan.skip]
    .toSorted((left, right) => left.device.localeCompare(right.device))
    .map(({ device, build, reason }) => `${build ? "build" : "skip"} ${device}: ${reason}`);
}

/**
 * A git repository with the firmware tree's shape: boards `a`, `b` and `mac`, shared `common` and
 * `components/x`, host-only files, tests, docs and the builder.
 */
function firmwareRepository() {
  const root = mkdtempSync(join(tmpdir(), "kit-firmware-plan-"));
  const devices = [
    { id: "device-a", target: "a" },
    { id: "device-b", target: "b" },
  ];
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = (files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
    }
    git("add", ".");
    git(
      ...["-c", "user.name=Kit Firmware Test", "-c", "user.email=kit-firmware@example.invalid"],
      ...["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"],
    );
  };
  const head = () => git("rev-parse", "HEAD");
  const version = (sha: string) =>
    firmwareVersion({
      count: Number(git("rev-list", "--count", "--first-parent", sha)),
      date: new Date(Number(git("log", "-1", "--format=%ct", sha)) * 1000),
      commit: sha,
    });

  git("init", "--quiet");
  commit(
    Object.fromEntries(
      [
        "devices/a/board.c",
        "devices/b/board.c",
        "devices/mac/board.c",
        "targets/a/CMakeLists.txt",
        "targets/b/CMakeLists.txt",
        "targets/common/sdkconfig.defaults",
        "targets/mac/CMakeLists.txt",
        "CMakeLists.txt",
        "platforms/host/esp_idf.c",
        "tests/board_test.c",
        "components/x/src/x.c",
        "components/x/tests/x_test.c",
        "README.md",
      ].map((file) => [`apps/kit/firmware/${file}`, file]),
    ),
  );
  commit({ "apps/kit/scripts/firmware-release.ts": "// the builder" });

  return {
    commit,
    head,
    version,
    /** A release of every device at HEAD. */
    releaseAll: () =>
      devices.map(({ id }) => ({ deviceId: id, version: version(head()), commit: head() })),
    plan: (input: {
      releases: Parameters<typeof planFirmwareReleases>[0]["releases"];
      force?: boolean;
      publish?: boolean;
      base?: string;
      headVersion?: string;
    }) =>
      planFirmwareReleases({
        repoRoot: root,
        devices,
        force: false,
        publish: false,
        headVersion: version(head()),
        ...input,
      }),
    [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** targets/common/partitions-16mb-model.csv as gen_esp32part.py writes it: entries, the MD5 row, FF. */
function havpeTable() {
  const entries = [
    { label: "nvs", type: 0x01, subtype: 0x02, offset: 0x9000, size: 0x6000 },
    { label: "phy_init", type: 0x01, subtype: 0x01, offset: 0xf000, size: 0x1000 },
    { label: "ota_0", type: 0x00, subtype: 0x10, offset: 0x10000, size: 0x500000 },
    { label: "iterate_kit", type: 0x40, subtype: 0x00, offset: 0x510000, size: 0x1000 },
    { label: "otadata", type: 0x01, subtype: 0x00, offset: 0x511000, size: 0x2000 },
    { label: "ota_1", type: 0x00, subtype: 0x11, offset: 0x520000, size: 0x500000 },
    { label: "model", type: 0x01, subtype: 0x82, offset: 0xa20000, size: 0x400000 },
  ];
  const bytes = new Uint8Array(0xc00).fill(0xff);
  const view = new DataView(bytes.buffer);
  for (const [index, entry] of entries.entries()) {
    const cursor = index * 32;
    bytes.set([0xaa, 0x50, entry.type, entry.subtype], cursor);
    view.setUint32(cursor + 4, entry.offset, true);
    view.setUint32(cursor + 8, entry.size, true);
    bytes.fill(0, cursor + 12, cursor + 32);
    bytes.set(new TextEncoder().encode(entry.label), cursor + 12);
  }
  // the MD5 row: EB EB, fourteen FF bytes, then the digest
  bytes.set([0xeb, 0xeb], entries.length * 32);
  bytes.fill(0x12, entries.length * 32 + 16, entries.length * 32 + 32);
  return bytes;
}
