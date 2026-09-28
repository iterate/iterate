import { expect, test, vi } from "vitest";
import { findFirmwareDevice } from "./catalog.ts";
import { newestFirmware, newestFirmwareVersion } from "./releases.ts";

const device = findFirmwareDevice("waveshare")!;
const refsUrl =
  "https://api.github.com/repos/iterate/iterate/git/matching-refs/tags/kit-firmware/waveshare/";
const older = "002570-2026-09-20-0a1b2c3";
const newer = "002574-2026-09-23-b2a4558";

test("newestFirmwareVersion: the newest of the device's release tags on GitHub", async () => {
  const fetchImpl = github(tags(older, newer, "002572-2026-09-21-ffffff0"));

  await expect(newestFirmwareVersion(device.id, fetchImpl)).resolves.toBe(newer);
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(refsUrl, {
    headers: { accept: "application/vnd.github+json" },
  });
});

test("newestFirmwareVersion: skips, with a warning, a tag that is not a release version", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const refs = [
    ...tags(older, "latest", `${newer}/extra`, "2574-2026-09-23-b2a4558"),
    { ref: "refs/tags/v2026-09-23" },
  ];

  await expect(newestFirmwareVersion(device.id, github(refs))).resolves.toBe(older);
  expect(warn).toHaveBeenCalledTimes(4);
  expect(warn).toHaveBeenCalledWith(
    "Ignoring refs/tags/kit-firmware/waveshare/latest: not kit-firmware/waveshare/<version>.",
  );
});

test("newestFirmware: the newest release's checked manifest", async () => {
  stubKitPage();
  const fetchImpl = github(tags(older, newer));

  await expect(newestFirmware(device, fetchImpl)).resolves.toMatchObject({
    manifest: {
      name: device.name,
      version: newer,
      builds: [
        { parts: [{ path: `https://k.iterate.com/firmware/waveshare/${newer}/bootloader.bin` }] },
      ],
    },
  });
  // the tag listing and the newest release's manifest: no other release is fetched
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

test.for([
  {
    name: "a device with no release",
    fetchImpl: () => github([]),
    problem: "No firmware has been released for Waveshare ESP32-S3 Touch AMOLED yet.",
  },
  {
    name: "a GitHub error",
    fetchImpl: () => github({ message: "Server Error" }, { status: 500 }),
    problem: "Could not list firmware releases: GitHub returned HTTP 500.",
  },
  {
    name: "a manifest Kit could not serve",
    fetchImpl: () =>
      vi.fn<typeof fetch>(async (input) =>
        String(input) === refsUrl
          ? Response.json(tags(newer))
          : new Response("GitHub did not serve this firmware file.", { status: 502 }),
      ),
    problem: "Firmware manifest returned HTTP 502.",
  },
])("newestFirmware: $name is the page's problem", async (row) => {
  stubKitPage();

  await expect(newestFirmware(device, row.fetchImpl())).resolves.toEqual({
    problem: row.problem,
  });
});

test("newestFirmware: an exhausted GitHub rate limit says when to try again", async () => {
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

  await expect(newestFirmware(device, fetchImpl)).resolves.toEqual({
    problem: `GitHub's hourly limit for this network is used up. Try again after ${reset.toLocaleTimeString()}.`,
  });
});

/** The page the loader runs on; the Kit vitest config unstubs it after each test. */
function stubKitPage() {
  vi.stubGlobal("window", {
    location: { href: "https://k.iterate.com/devices/waveshare" },
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
      name: device.name,
      version,
      builds: [{ chipFamily: "ESP32-S3", parts: [{ path: "./bootloader.bin", offset: 0 }] }],
      configurationPartition: { offset: 0x510000, size: 0x1000 },
    });
  });
}
