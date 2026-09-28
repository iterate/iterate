import { findFirmwareDevice } from "./catalog.ts";

/** A separate CIMD identity per provisioning, with no credential or device identifier in its URL. */
export function deviceClientMetadata(url: URL): Response | null {
  const match =
    /^\/devices\/([^/]+)\/clients\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.json$/.exec(
      url.pathname,
    );
  if (!match) return null;
  const device = findFirmwareDevice(match[1]!);
  if (!device) return new Response("Unknown device", { status: 404 });
  return Response.json(
    {
      client_id: `${url.origin}${url.pathname}`,
      client_name: device.name,
      client_uri: device.vendor.url,
      logo_uri: `${url.origin}/vendors/${device.vendor.icon}`,
      redirect_uris: [`${url.origin}/.auth/callback`],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
