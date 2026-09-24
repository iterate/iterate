import { z } from "zod";
import {
  DEFAULT_FIRMWARE_VERSION,
  FIRMWARE_REPOSITORY,
  FIRMWARE_VERSION_PATTERN,
  firmwareReleaseTag,
  type FirmwareDevice,
} from "./catalog.ts";
import { loadFirmwareManifest } from "./prepare-manifest.ts";

/**
 * What the firmware picker shows for `requested` (a version, or `latest` for the newest): the
 * device's released versions, newest first, and either the selected version's checked manifest or
 * the `problem` that stops it from being flashed. A device with no release, a version that is not
 * released, a failed listing and a bad manifest are all page state the picker shows, so they come
 * back as `problem` instead of failing the route.
 */
export async function selectFirmware(
  device: FirmwareDevice,
  requested: string,
  fetchImpl: typeof fetch,
) {
  let versions: string[] = [];
  try {
    versions = await listFirmwareVersions(device.id, fetchImpl);
    if (versions.length === 0) {
      return { versions, problem: `No firmware has been released for ${device.name} yet.` };
    }
    const version = requested === DEFAULT_FIRMWARE_VERSION ? versions[0]! : requested;
    if (!versions.includes(version)) {
      return { versions, problem: `Release ${version} is not published for ${device.name}.` };
    }
    const manifest = await loadFirmwareManifest({ deviceId: device.id, version }, fetchImpl);
    return { versions, version, manifest };
  } catch (error) {
    return { versions, problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A device's released firmware versions, newest first, from the tags `firmwareReleaseTag` names.
 *
 * The browser lists them itself, from GitHub's public REST API: `git/matching-refs` answers with
 * `access-control-allow-origin: *` and returns every match unpaginated, and an anonymous request
 * counts against the viewer's own IP (60 an hour, and GitHub marks the answer cacheable for 60 s),
 * so Kit's Worker holds no GitHub token and spends no shared budget.
 * https://docs.github.com/en/rest/git/refs#list-matching-references
 * https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 *
 * A tag under the device's prefix that is not a release version is skipped with a warning, so a
 * stray tag can never become the default.
 */
export async function listFirmwareVersions(deviceId: string, fetchImpl: typeof fetch) {
  // `kit-firmware/<id>/`: the trailing slash keeps `waveshare` from matching `waveshare-rlcd-4-2`
  const tagPrefix = firmwareReleaseTag(deviceId, "");
  const response = await fetchImpl(
    `https://api.github.com/repos/${FIRMWARE_REPOSITORY}/git/matching-refs/tags/${tagPrefix}`,
    { headers: { accept: "application/vnd.github+json" } },
  );
  if (!response.ok) {
    // GitHub answers an exhausted anonymous budget with 403 (or 429) and these headers
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = new Date(Number(response.headers.get("x-ratelimit-reset")) * 1000);
      throw new Error(
        `GitHub's hourly limit for this network is used up. Try again after ${reset.toLocaleTimeString()}.`,
      );
    }
    throw new Error(`Could not list firmware releases: GitHub returned HTTP ${response.status}.`);
  }
  const refs = z.array(z.object({ ref: z.string() })).parse(await response.json());
  const versions = [];
  for (const { ref } of refs) {
    const version = ref.startsWith(`refs/tags/${tagPrefix}`)
      ? ref.slice(`refs/tags/${tagPrefix}`.length)
      : "";
    if (FIRMWARE_VERSION_PATTERN.test(version)) versions.push(version);
    else console.warn(`Ignoring ${ref}: not ${firmwareReleaseTag(deviceId, "<version>")}.`);
  }
  // versions sort as strings (FIRMWARE_VERSION_PATTERN)
  return versions.sort().reverse();
}
