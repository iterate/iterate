import { appSession, issuerOriginOf, startAppSession } from "iterate/app-server";
import type { BrowserSession } from "iterate/app-session";
import { isLocalOrigin, sameOriginPath } from "iterate/lib";
import { kitEnvs } from "../../../envs.ts";
import { DEFAULT_FIRMWARE_VERSION, findFirmwareDevice } from "./firmware/catalog.ts";
import { deviceVendors } from "./firmware/device-client.ts";

/** Kit chooses a fresh client BEFORE consent. The stored identity then follows setup to the board.
 *  The platform it signs in to is `ITERATE_ORIGIN`, or another iterate platform (a self-hosted one)
 *  that a connect link named: `/.auth/connect?issuer=<origin>` carries it to device selection, whose
 *  login button names it and posts it back as `?issuer=`. */
export async function deviceAuth(
  request: Request,
  env: {
    BROWSER_SESSION: DurableObjectNamespace<BrowserSession>;
    ITERATE_ORIGIN: string;
    ITERATE_DENY_ZONES: string;
  },
  deps: {
    /** app-server.ts `issuerAnswersAt`: null when the origin's discovery document names it */
    issuerAnswersAt: (origin: string) => Promise<string | null>;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  const issuerOf = (candidate: string) =>
    issuerOriginOf(candidate, {
      defaultIssuer: env.ITERATE_ORIGIN,
      denyZones: env.ITERATE_DENY_ZONES.split(",").filter(Boolean),
    });
  const login = /^\/devices\/([^/]+)\/login$/.exec(url.pathname);
  if (login) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (request.headers.get("origin") !== url.origin)
      return new Response("Cross-site request refused", { status: 403 });
    const device = findFirmwareDevice(login[1]!);
    if (!device) return new Response("Unknown device", { status: 404 });
    // Checked before this browser's installer session ends: a refused platform changes nothing.
    const named = issuerOf(url.searchParams.get("issuer") || env.ITERATE_ORIGIN);
    if ("error" in named) return refused(named.error);
    const issuer = named.origin;
    if (issuer !== env.ITERATE_ORIGIN) {
      const answer = await deps.issuerAnswersAt(issuer);
      if (answer) return refused(answer);
    }
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
      // Ending it signs out at its platform. When that fails the session is left behind rather than
      // blocking: a platform that's gone (a torn-down self-host, a deleted PR preview, which can
      // still serve its discovery document) fails every time, and would block every other board
      // in this browser. It's only this browser's setup session, never a board's token, and its
      // grant can still be ended from the sessions list on a platform that's up.
      const previous = appSession(env.BROWSER_SESSION, request);
      await previous?.end().catch(async (error: unknown) => {
        console.warn("kit.device_login_left_session", {
          platform: (await previous.host().catch(() => null))?.issuer,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      const { location, setCookie } = await startAppSession(
        env.BROWSER_SESSION,
        {
          origin: url.origin,
          issuer,
          resource: `${issuer}/api`,
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
  // Old bookmarks and expired sessions return to the public selector, never generic Kit consent. A
  // connect link's platform goes with them, checked; the selector's login button names it.
  if (url.pathname === "/.auth/login" || url.pathname === "/.auth/connect") {
    const next = new URL(
      sameOriginPath(url.searchParams.get("next") || "/", url.origin),
      url.origin,
    );
    const model = /^\/devices\/([^/]+)\//.exec(next.pathname)?.[1];
    const selection = new URLSearchParams();
    if (model && findFirmwareDevice(model)) selection.set("device", model);
    const candidate = url.searchParams.get("issuer");
    if (url.pathname === "/.auth/connect" && candidate) {
      const named = issuerOf(candidate);
      if ("error" in named) return refused(named.error);
      if (named.origin !== env.ITERATE_ORIGIN) selection.set("issuer", named.origin);
    }
    return new Response(null, {
      status: 303,
      headers: {
        Location: selection.size ? `/?${selection}` : "/",
        "Cache-Control": "no-store",
      },
    });
  }
  return null;
}

const refused = (reason: string) =>
  new Response(reason, {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
