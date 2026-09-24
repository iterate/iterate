import {
  FIRMWARE_REPOSITORY,
  FIRMWARE_VERSION_PATTERN,
  findFirmwareDevice,
  firmwareReleaseTag,
} from "./catalog.ts";

/**
 * Serves `/firmware/<device id>/<version>/<file>`, one file of a firmware release, streamed from
 * `https://github.com/iterate/iterate/releases/download/kit-firmware/<device id>/<version>/<file>`;
 * `null` for every other path.
 *
 * Why a proxy: esp-web-tools 10.4.0 `fetch()`es the manifest and every part from the page
 * (src/flash.ts, `build.parts.map(... fetch(url))`), but GitHub's download URL and the
 * release-assets.githubusercontent.com URL it redirects to send no `Access-Control-Allow-Origin`.
 * A plain 200 on Kit's origin is also what a device's own update would need
 * (firmware/platforms/iterate_esp_idf/system_update.c accepts only a 200 and follows no redirect).
 *
 * The path is checked before anything is fetched, so the Worker only ever requests release files of
 * catalog devices from this repository: a known device, a release version and a plain `.bin` or
 * `.json` file name. The response carries none of GitHub's headers, only Kit's own.
 */
export async function proxyFirmwareFile(request: Request, fetchGitHub: typeof fetch) {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/firmware/")) return null;
  if (request.method !== "GET") {
    return new Response("Method not allowed.\n", { status: 405, headers: { allow: "GET" } });
  }
  const [deviceId = "", version = "", file = "", ...rest] = pathname
    .slice("/firmware/".length)
    .split("/");
  if (
    rest.length > 0 ||
    !findFirmwareDevice(deviceId) ||
    !FIRMWARE_VERSION_PATTERN.test(version) ||
    !/^[a-z0-9][a-z0-9._-]*\.(bin|json)$/.test(file)
  ) {
    return notFound();
  }
  const url = `https://github.com/${FIRMWARE_REPOSITORY}/releases/download/${firmwareReleaseTag(deviceId, version)}/${file}`;
  const upstream = await fetchGitHub(url);
  if (upstream.ok) {
    return new Response(upstream.body, {
      headers: {
        "content-type": file.endsWith(".json") ? "application/json" : "application/octet-stream",
        // a release's files never change: its tag is only ever created, or deleted to yank it
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (upstream.status === 404) return notFound();
  console.error("kit.firmware_download_failed", { url, status: upstream.status });
  return new Response("GitHub did not serve this firmware file.\n", {
    status: 502,
    headers: { "content-type": "text/plain" },
  });
}

function notFound() {
  return new Response("Not found.\n", { status: 404, headers: { "content-type": "text/plain" } });
}
