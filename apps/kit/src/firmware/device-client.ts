import { findFirmwareDevice } from "./catalog.ts";

/** Vendor artwork is served locally so a device's identity does not depend on a vendor CDN. */
export const deviceVendors: Record<string, { name: string; icon: string; url: string }> = {
  "home-assistant-voice-preview-edition": {
    name: "Home Assistant",
    icon: "home-assistant.png",
    url: "https://www.home-assistant.io/voice-pe/",
  },
  satellite1: {
    name: "FutureProofHomes",
    icon: "futureproofhomes.png",
    url: "https://futureproofhomes.net/",
  },
  "m5stick-s3": { name: "M5Stack", icon: "m5stack.ico", url: "https://m5stack.com/" },
  stackchan: { name: "M5Stack", icon: "m5stack.ico", url: "https://m5stack.com/" },
  waveshare: { name: "Waveshare", icon: "waveshare.ico", url: "https://www.waveshare.com/" },
  "waveshare-rlcd-4-2": {
    name: "Waveshare",
    icon: "waveshare.ico",
    url: "https://www.waveshare.com/",
  },
  "zectrix-note4": { name: "ZECTRIX", icon: "zectrix.png", url: "https://zectrix.com/" },
};

/** A separate CIMD identity per provisioning, with no credential or device identifier in its URL. */
export function deviceClientMetadata(url: URL): Response | null {
  const match =
    /^\/devices\/([^/]+)\/clients\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.json$/.exec(
      url.pathname,
    );
  if (!match) return null;
  const device = findFirmwareDevice(match[1]!);
  const vendor = deviceVendors[match[1]!];
  if (!device || !vendor) return new Response("Unknown device", { status: 404 });
  return Response.json(
    {
      client_id: `${url.origin}${url.pathname}`,
      client_name: device.name,
      client_uri: vendor.url,
      logo_uri: `${url.origin}/vendors/${vendor.icon}`,
      redirect_uris: [`${url.origin}/.auth/callback`],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
