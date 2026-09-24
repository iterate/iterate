import { expect, test, vi } from "vitest";
import { findFirmwareDevice } from "./catalog.ts";
import { listFirmwareVersions, selectFirmware } from "./releases.ts";

const device = findFirmwareDevice("waveshare")!;
const refsUrl =
  "https://api.github.com/repos/iterate/iterate/git/matching-refs/tags/kit-firmware/waveshare/";
const older = "002570-2026-09-20-0a1b2c3";
const newer = "002574-2026-09-23-b2a4558";

test("listFirmwareVersions: the device's release tags from GitHub, newest first", async () => {
  const fetchImpl = github(tags(older, newer, "002572-2026-09-21-ffffff0"));

  await expect(listFirmwareVersions(device.id, fetchImpl)).resolves.toEqual([
    newer,
    "002572-2026-09-21-ffffff0",
    older,
  ]);
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(refsUrl, {
    headers: { accept: "application/vnd.github+json" },
  });
});

test("listFirmwareVersions: skips, with a warning, a tag that is not a release version", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const refs = [
    ...tags(newer, "latest", `${newer}/extra`, "2574-2026-09-23-b2a4558"),
    { ref: "refs/tags/v2026-09-23" },
  ];

  await expect(listFirmwareVersions(device.id, github(refs))).resolves.toEqual([newer]);
  expect(warn).toHaveBeenCalledTimes(4);
  expect(warn).toHaveBeenCalledWith(
    "Ignoring refs/tags/kit-firmware/waveshare/latest: not kit-firmware/waveshare/<version>.",
  );
});

test("selectFirmware: latest is the newest release, with its checked manifest", async () => {
  stubKitPage();

  await expect(selectFirmware(device, "latest", github(tags(older, newer)))).resolves.toMatchObject(
    {
      versions: [newer, older],
      version: newer,
      manifest: {
        version: newer,
        builds: [
          { parts: [{ path: `https://k.iterate.com/firmware/waveshare/${newer}/bootloader.bin` }] },
        ],
      },
    },
  );
});

test("selectFirmware: an older release can be chosen", async () => {
  stubKitPage();

  await expect(selectFirmware(device, older, github(tags(older, newer)))).resolves.toMatchObject({
    versions: [newer, older],
    version: older,
    manifest: { version: older },
  });
});

test.for([
  {
    name: "a device with no release",
    requested: "latest",
    fetchImpl: () => github([]),
    versions: [],
    problem: "No firmware has been released for Waveshare ESP32-S3 Touch AMOLED yet.",
  },
  {
    name: "a version that is not released",
    requested: "000001-2000-01-01-0000000",
    fetchImpl: () => github(tags(newer)),
    versions: [newer],
    problem:
      "Release 000001-2000-01-01-0000000 is not published for Waveshare ESP32-S3 Touch AMOLED.",
  },
  {
    name: "a GitHub error",
    requested: "latest",
    fetchImpl: () => github({ message: "Server Error" }, { status: 500 }),
    versions: [],
    problem: "Could not list firmware releases: GitHub returned HTTP 500.",
  },
  {
    name: "a manifest Kit could not serve",
    requested: "latest",
    fetchImpl: () =>
      vi.fn<typeof fetch>(async (input) =>
        String(input) === refsUrl
          ? Response.json(tags(newer))
          : new Response("GitHub did not serve this firmware file.", { status: 502 }),
      ),
    versions: [newer],
    problem: "Firmware manifest returned HTTP 502.",
  },
])("selectFirmware: $name is the picker's problem", async (row) => {
  stubKitPage();

  await expect(selectFirmware(device, row.requested, row.fetchImpl())).resolves.toEqual({
    versions: row.versions,
    problem: row.problem,
  });
});

test("selectFirmware: an exhausted GitHub rate limit says when to try again", async () => {
  const reset = new Date("2026-09-24T03:00:00Z");
  const fetchImpl = github(
    { message: "API rate limit exceeded" },
    {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset.getTime() / 1000),
      },
    },
  );

  await expect(selectFirmware(device, "latest", fetchImpl)).resolves.toEqual({
    versions: [],
    problem: `GitHub's hourly limit for this network is used up. Try again after ${reset.toLocaleTimeString()}.`,
  });
});

/** The page the loader runs on; the Kit vitest config unstubs it after each test. */
function stubKitPage() {
  vi.stubGlobal("window", {
    location: { href: "https://k.iterate.com/devices/waveshare/firmware/latest" },
    addEventListener: vi.fn(),
  });
}

function tags(...versions: string[]) {
  return versions.map((version) => ({ ref: `refs/tags/kit-firmware/waveshare/${version}` }));
}

/** GitHub's refs listing, and Kit's manifest route for whichever version is asked for. */
function github(refs: unknown, init?: ResponseInit) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === refsUrl) return Response.json(refs, init);
    const version =
      /^https:\/\/k\.iterate\.com\/firmware\/waveshare\/([^/]+)\/manifest\.json$/.exec(url)?.[1];
    if (!version) throw new Error(`unexpected fetch ${url}`);
    return Response.json({
      version,
      builds: [{ chipFamily: "ESP32-S3", parts: [{ path: "./bootloader.bin", offset: 0 }] }],
      configurationPartition: { offset: 0x410000, size: 0x1000 },
    });
  });
}
