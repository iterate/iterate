import { expect, test, vi } from "vitest";
import { proxyFirmwareFile } from "./firmware-proxy.ts";

const device = "home-assistant-voice-preview-edition";
const version = "002574-2026-09-23-b2a4558";

test("leaves every path outside /firmware/ to the rest of the Worker", async () => {
  const fetchGitHub = github(() => new Response("unexpected"));

  for (const path of ["/", "/firmware", "/devices/x/firmware/latest", "/healthz"]) {
    await expect(
      proxyFirmwareFile(new Request(`https://k.iterate.com${path}`), fetchGitHub),
    ).resolves.toBeNull();
  }
  expect(fetchGitHub).not.toHaveBeenCalled();
});

test("streams a release file from GitHub with only Kit's own headers", async () => {
  const fetchGitHub = github(
    () =>
      new Response("bootloader bytes", {
        headers: { "set-cookie": "logged_in=no", "content-type": "text/html" },
      }),
  );

  const response = await proxyFirmwareFile(
    new Request(`https://k.iterate.com/firmware/${device}/${version}/bootloader.bin`),
    fetchGitHub,
  );

  expect(fetchGitHub).toHaveBeenCalledExactlyOnceWith(
    `https://github.com/iterate/iterate/releases/download/kit-firmware/${device}/${version}/bootloader.bin`,
  );
  expect(response).toMatchObject({ status: 200 });
  expect(Object.fromEntries(response!.headers)).toEqual({
    "content-type": "application/octet-stream",
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  });
  await expect(response!.text()).resolves.toBe("bootloader bytes");
});

test("serves manifest.json as JSON", async () => {
  const response = await proxyFirmwareFile(
    new Request(`https://k.iterate.com/firmware/${device}/${version}/manifest.json`),
    github(() => Response.json({ version })),
  );

  expect(response?.headers.get("content-type")).toBe("application/json");
});

test("refuses anything but GET", async () => {
  const fetchGitHub = github(() => new Response("unexpected"));

  const response = await proxyFirmwareFile(
    new Request(`https://k.iterate.com/firmware/${device}/${version}/manifest.json`, {
      method: "POST",
    }),
    fetchGitHub,
  );

  expect(response?.status).toBe(405);
  expect(response?.headers.get("allow")).toBe("GET");
  expect(fetchGitHub).not.toHaveBeenCalled();
});

test.for([
  ["an unknown device", `nope/${version}/manifest.json`],
  ["latest as the version", `${device}/latest/manifest.json`],
  ["a malformed version", `${device}/2574-2026-09-23-b2a4558/manifest.json`],
  ["an uppercase file", `${device}/${version}/Bootloader.bin`],
  ["a file without an extension", `${device}/${version}/manifest`],
  ["another extension", `${device}/${version}/notes.md`],
  ["an encoded path traversal", `${device}/${version}/..%2f..%2fx.bin`],
  ["two segments", `${device}/manifest.json`],
  ["four segments", `${device}/${version}/sub/manifest.json`],
  ["a trailing slash", `${device}/${version}/manifest.json/`],
])("404s %s without asking GitHub", async ([, path]) => {
  const fetchGitHub = github(() => new Response("unexpected"));

  const response = await proxyFirmwareFile(
    new Request(`https://k.iterate.com/firmware/${path}`),
    fetchGitHub,
  );

  expect(response?.status).toBe(404);
  expect(response?.headers.get("content-type")).toBe("text/plain");
  expect(fetchGitHub).not.toHaveBeenCalled();
});

test("passes on GitHub's 404 for a file that is not released", async () => {
  const response = await proxyFirmwareFile(
    new Request(`https://k.iterate.com/firmware/${device}/${version}/missing.bin`),
    github(() => new Response("Not Found", { status: 404 })),
  );

  expect(response?.status).toBe(404);
});

test("answers any other GitHub failure with 502 and logs it", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  const response = await proxyFirmwareFile(
    new Request(`https://k.iterate.com/firmware/${device}/${version}/bootloader.bin`),
    github(() => new Response("oops", { status: 500 })),
  );

  expect(response?.status).toBe(502);
  expect(error).toHaveBeenCalledExactlyOnceWith("kit.firmware_download_failed", {
    url: `https://github.com/iterate/iterate/releases/download/kit-firmware/${device}/${version}/bootloader.bin`,
    status: 500,
  });
});

/** GitHub's release download, answering every request with `response()`. */
function github(response: () => Response) {
  return vi.fn<typeof fetch>(async () => response());
}
