import { appSession, startAppSession } from "iterate/next/app-server";
import type { BrowserSession } from "iterate/next/app-session";
import { isLocalOrigin, sameOriginPath } from "iterate/next/lib";
import { kitEnvs } from "../../../envs.ts";
import { DEFAULT_FIRMWARE_VERSION, findFirmwareDevice } from "./firmware/catalog.ts";
import { deviceVendors } from "./firmware/device-client.ts";

/** Kit chooses a fresh client BEFORE consent. The stored identity then follows setup to the board. */
export async function deviceAuth(
  request: Request,
  env: { BROWSER_SESSION: DurableObjectNamespace<BrowserSession>; ITERATE_ORIGIN: string },
): Promise<Response | null> {
  const url = new URL(request.url);
  const login = /^\/devices\/([^/]+)\/login$/.exec(url.pathname);
  if (login) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (request.headers.get("origin") !== url.origin)
      return new Response("Cross-site request refused", { status: 403 });
    const device = findFirmwareDevice(login[1]!);
    if (!device) return new Response("Unknown device", { status: 404 });
    const vendor = deviceVendors[device.id]!;
    // Local OAuth uses dynamic registration; deployed clients publish their own HTTPS metadata.
    const metadataOrigin = isLocalOrigin(url.origin) ? kitEnvs.prd.baseUrl : url.origin;
    const client = {
      id: `${metadataOrigin}/devices/${device.id}/clients/${crypto.randomUUID()}.json`,
      name: device.name,
      logoUri: `${metadataOrigin}/vendors/${vendor.icon}`,
    };
    try {
      // A deliberate POST replaces only this browser's installer session, never a flashed token.
      await appSession(env.BROWSER_SESSION, request)?.end();
      const { location, setCookie } = await startAppSession(
        env.BROWSER_SESSION,
        {
          origin: url.origin,
          issuer: env.ITERATE_ORIGIN,
          resource: `${env.ITERATE_ORIGIN}/api`,
          scopes: ["iterate", "account"],
          client,
        },
        `/devices/${device.id}/firmware/${DEFAULT_FIRMWARE_VERSION}`,
      );
      return new Response(null, {
        status: 303,
        headers: {
          Location: location,
          "Set-Cookie": setCookie,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    } catch (error) {
      console.error("kit.device_login_failed", { deviceId: device.id, error });
      return new Response("Device sign-in could not start. Go back and try again.", {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
  }
  if (url.pathname === "/device-session.json") {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const session = appSession(env.BROWSER_SESSION, request);
    const client = await session?.client();
    const deviceId =
      client?.id && /^\/devices\/([^/]+)\/clients\//.exec(new URL(client.id).pathname)?.[1];
    if (!deviceId || !findFirmwareDevice(deviceId) || !(await session?.bearer()))
      return Response.json(null, { status: 401, headers: { "Cache-Control": "no-store" } });
    return Response.json(
      { deviceId, clientId: client.id },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  // Old bookmarks and expired sessions return to the public selector, never generic Kit consent.
  if (url.pathname === "/.auth/login" || url.pathname === "/.auth/connect") {
    const next = new URL(
      sameOriginPath(url.searchParams.get("next") || "/", url.origin),
      url.origin,
    );
    const model = /^\/devices\/([^/]+)\//.exec(next.pathname)?.[1];
    return new Response(null, {
      status: 303,
      headers: {
        Location: model && findFirmwareDevice(model) ? `/?device=${model}` : "/",
        "Cache-Control": "no-store",
      },
    });
  }
  return null;
}
