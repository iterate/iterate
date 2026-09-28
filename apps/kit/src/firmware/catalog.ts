export const DEFAULT_DEVICE_ID = "home-assistant-voice-preview-edition";
export const DEFAULT_FIRMWARE_VERSION = "latest";

/**
 * Firmware ships as GitHub releases of this repository, one per device build, tagged by
 * `firmwareReleaseTag` (apps/kit/scripts/firmware-release.ts builds them; apps/kit/README.md
 * "Firmware releases").
 */
export const FIRMWARE_REPOSITORY = "iterate/iterate";

/**
 * A release version: `<first-parent commit count, zero-padded to 6>-<UTC committer date>-<commit
 * sha7>`, e.g. `002574-2026-09-23-b2a4558`. Main is linear, so the count only grows and versions
 * sort as strings; the date is for people. It is also the firmware's `PROJECT_VER`, so it must fit
 * the 31 characters of `esp_app_desc_t.version`, which the device reports in `X-Iterate-Fw`.
 */
export const FIRMWARE_VERSION_PATTERN = /^\d{6}-\d{4}-\d{2}-\d{2}-[0-9a-f]{7}$/;

/**
 * The git tag (and release name) of one device's firmware release, e.g.
 * `kit-firmware/home-assistant-voice-preview-edition/002574-2026-09-23-b2a4558`. GitHub serves
 * tags with slashes, both for release downloads and for `git/matching-refs/tags/<prefix>/`.
 */
export function firmwareReleaseTag(deviceId: string, version: string) {
  return `kit-firmware/${deviceId}/${version}`;
}

export interface FirmwareDevice {
  id: string;
  /** `firmware/targets/<target>` and `firmware/devices/<target>`, this board's own directories. */
  target: string;
  name: string;
  description: string;
  /** Its maker: consent's client link and icon, the selector's icon. The artwork is one of
   *  Kit's own `public/vendors` files, so a device's identity does not depend on a vendor CDN. */
  vendor: { name: string; icon: string; url: string };
  /** How a person starts a call once the board is set up (from its `firmware/devices/<target>`
   *  board table and README): Kit's done screen says it. */
  startCall: string;
}

/**
 * The supported ESP32-S3 boards, in the installer's order. Each one's firmware is a series of GitHub
 * releases (`firmwareReleaseTag`) that the Kit Firmware workflow builds from `target`; Kit lists
 * them in the browser (releases.ts) and streams their files (firmware-proxy.ts).
 */
export const firmwareCatalog: readonly FirmwareDevice[] = [
  {
    id: "zectrix-note4",
    target: "zectrix_note4",
    name: "ZECTRIX NOTE4",
    description: "E-paper voice companion with monochrome and 16-level grayscale images",
    vendor: { name: "ZECTRIX", icon: "zectrix.png", url: "https://zectrix.com/" },
    startCall: "Press OK.",
  },
  {
    id: "waveshare-rlcd-4-2",
    target: "waveshare_s3_rlcd",
    name: "Waveshare ESP32-S3 RLCD 4.2",
    description: "Reflective display and KEY-button voice companion (experimental audio)",
    vendor: { name: "Waveshare", icon: "waveshare.ico", url: "https://www.waveshare.com/" },
    startCall: "Press KEY.",
  },
  {
    id: DEFAULT_DEVICE_ID,
    target: "havpe",
    name: "Home Assistant Voice Preview Edition",
    description: "ESP32-S3 voice satellite",
    vendor: {
      name: "Home Assistant",
      icon: "home-assistant.png",
      url: "https://www.home-assistant.io/voice-pe/",
    },
    startCall: 'Press the button on top, or say "Jarvis".',
  },
  {
    id: "satellite1",
    target: "satellite1",
    name: "FutureProofHomes Satellite1",
    description: "ESP32-S3 XMOS voice satellite",
    vendor: {
      name: "FutureProofHomes",
      icon: "futureproofhomes.png",
      url: "https://futureproofhomes.net/",
    },
    startCall: 'Press its button, or say "Jarvis".',
  },
  {
    id: "m5stick-s3",
    target: "m5sticks3",
    name: "M5StickS3",
    description: "ESP32-S3 pocket voice companion",
    vendor: { name: "M5Stack", icon: "m5stack.ico", url: "https://m5stack.com/" },
    startCall: "Press either button on the front or side.",
  },
  {
    id: "stackchan",
    target: "stackchan",
    name: "StackChan",
    description: "M5Stack CoreS3 desktop companion",
    vendor: { name: "M5Stack", icon: "m5stack.ico", url: "https://m5stack.com/" },
    startCall: "Tap its face or its side button.",
  },
  {
    id: "waveshare",
    target: "waveshare_s3_amoled",
    name: "Waveshare ESP32-S3 Touch AMOLED",
    description: "ESP32-S3 screen voice companion",
    vendor: { name: "Waveshare", icon: "waveshare.ico", url: "https://www.waveshare.com/" },
    startCall: "Press the upper (BOOT) button.",
  },
];

export function findFirmwareDevice(deviceId: string) {
  return firmwareCatalog.find((device) => device.id === deviceId);
}

/** Where Kit serves a release's `manifest.json`; its parts sit beside it (firmware-proxy.ts). */
export function firmwareManifestPath(deviceId: string, version: string) {
  return `/firmware/${encodeURIComponent(deviceId)}/${encodeURIComponent(version)}/manifest.json`;
}
