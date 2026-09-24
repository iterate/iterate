import { appSession, issuerOriginOf, sessionCookieName, startAppSession } from "iterate/app-server";
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
    // A deliberate POST replaces only this browser's installer session, never a flashed token. When
    // ending it fails (its platform is down, or gone), nothing new starts: the page says so and
    // offers to forget that session instead (`/.auth/forget`), the person's call to make.
    const previous = appSession(env.BROWSER_SESSION, request);
    try {
      await previous?.end();
    } catch (error) {
      console.error("kit.device_login_failed", { deviceId: device.id, error });
      const selection = new URLSearchParams({ device: device.id });
      if (issuer !== env.ITERATE_ORIGIN) selection.set("issuer", issuer);
      return couldNotEndPreviousSession(
        (await previous?.host().catch(() => null))?.issuer,
        `/.auth/forget?${selection}`,
      );
    }
    try {
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
  // Forget this browser's installer session without signing out at its platform (which failed): the
  // cookie goes, the session is left behind, and the person is back at device selection.
  if (url.pathname === "/.auth/forget") {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (request.headers.get("origin") !== url.origin)
      return new Response("Cross-site request refused", { status: 403 });
    const selection = new URLSearchParams();
    const model = url.searchParams.get("device");
    if (model && findFirmwareDevice(model)) selection.set("device", model);
    const named = issuerOf(url.searchParams.get("issuer") || env.ITERATE_ORIGIN);
    if (!("error" in named) && named.origin !== env.ITERATE_ORIGIN)
      selection.set("issuer", named.origin);
    return new Response(null, {
      status: 303,
      headers: {
        Location: selection.size ? `/?${selection}` : "/",
        "Set-Cookie": `${sessionCookieName(url)}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
        "Cache-Control": "no-store",
      },
    });
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

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!,
  );

/** The device login's refusal when this browser's earlier setup session couldn't be ended. */
function couldNotEndPreviousSession(platform: string | undefined, forget: string): Response {
  const host = platform ? escapeHtml(new URL(platform).host) : "";
  const where = host ? `through <strong>${host}</strong>` : "";
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Device sign-in could not start · Kit</title>
  </head>
  <body style="font: 15px/1.55 ui-sans-serif, system-ui, sans-serif; max-width: 34rem; margin: 15vh auto; padding: 0 1.25rem">
    <h1 style="font-size: 1.25rem">Device sign-in could not start</h1>
    <p>This browser is still signed in from an earlier device setup ${where}, and signing out there failed. It may be down, or gone.</p>
    <p>You can forget that sign-in here and start again.${host ? ` If ${host} is still up, that session stays valid there until it expires or you end it from its sessions list.` : ""}</p>
    <form method="post" action="${escapeHtml(forget)}">
      <button type="submit" style="font: inherit; padding: 0.5rem 1rem">Forget it and start again</button>
    </form>
    <p><a href="/">Back to device selection</a></p>
  </body>
</html>
`,
    {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    },
  );
}
