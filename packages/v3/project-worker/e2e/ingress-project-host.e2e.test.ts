// ingress-project-host.e2e.test.ts — PROJECT-HOST INGRESS (src/project-host.ts + worker.ts): an app
// is served at `/` on `<label>--<projectId>.<base>` with the URL verbatim, so its relative asset
// loads from the same host; inbound `x-itx-*` never reach it; the apex `<projectId>.<base>` is the
// label `default`; a label with no rule is a 404; and — deployed only, the local lane cannot set Host on a
// WebSocket — an upgrade rides through the host to the app. The app is one rule row: the log never
// names a hostname.

import { expect, test } from "vitest";
import { openItx } from "./support/client.ts";
import { mintProjectToken } from "./support/principal.ts";
import {
  fetchProjectHost,
  freshDnsSafeProjectId,
  projectHostnameBase,
  projectHostsAreLocal,
} from "./support/project-host.ts";

/** A site: HTML at `/` with a RELATIVE script, the script at `/app.js`, an echo of what it was handed
 *  at `/echo`, and a WebSocket echo on an upgrade. */
const SRC_SITE = {
  "cap.js": String.raw`import { WorkerEntrypoint } from "cloudflare:workers";
export default class Site extends WorkerEntrypoint {
  fetch(request) {
    const url = new URL(request.url);
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener("message", (e) => pair[1].send("site-echo:" + e.data));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/app.js")
      return new Response("document.title = 'site';", { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/echo")
      return Response.json({
        url: request.url,
        itxHeaders: [...request.headers.keys()].filter((name) => name.startsWith("x-itx-")),
        principal: JSON.parse(request.headers.get("x-itx-principal") || "null"),
      });
    return new Response(
      "<!doctype html><title>site</title><script src=\"app.js\"></script><p>" +
        url.host + url.pathname + url.search + "</p>",
      { headers: { "content-type": "text/html" } },
    );
  }
}`,
};

const siteRule = (): string => `itx.workers.get({ source: ${JSON.stringify(SRC_SITE)} })`;

test("an app is served at / on its project host — URL verbatim, relative asset intact, x-itx-* stripped, apex and 404", async () => {
  const projectId = freshDnsSafeProjectId("ingress");
  const base = projectHostnameBase();
  const itx = openItx(projectId);
  await itx.provide("itx.apps.site", siteRule());
  const host = `site--${projectId}.${base}`;

  // the page, with the URL it was asked for
  const page = await fetchProjectHost(host, "/w?repo=x");
  expect(page.status, page.text).toBe(200);
  expect(page.headers["content-type"]).toContain("text/html");
  expect(page.text).toContain(`<p>${host}/w?repo=x</p>`);
  // the page's relative script resolves on the same host
  const asset = await fetchProjectHost(host, "/app.js");
  expect(asset.status, asset.text).toBe(200);
  expect(asset.text).toContain("document.title");
  // a visitor's x-itx-* never reach the app (the lane's own header is set after the strip)
  const echo = await fetchProjectHost(host, "/echo", {
    "x-itx-expression": "itx.kv",
    "x-itx-visitor": "1",
  });
  const seen = JSON.parse(echo.text) as { url: string; itxHeaders: string[] };
  expect(seen.url).toContain(`//${host}/echo`);
  expect(seen.itxHeaders).not.toContain("x-itx-expression");
  expect(seen.itxHeaders).not.toContain("x-itx-visitor");
  // the apex host is the label `default` — one more rule points it at the same app
  await itx.provide("itx.apps.default", "itx.apps.site");
  const apex = await fetchProjectHost(`${projectId}.${base}`, "/");
  expect(apex.status, apex.text).toBe(200);
  expect(apex.text).toContain(`<p>${projectId}.${base}/</p>`);
  // a label no rule serves is the lane's 404 (NO_ITX_EXPRESSION_MATCH), never a 500
  const missing = await fetchProjectHost(`other--${projectId}.${base}`, "/");
  expect(missing.status, missing.text).toBe(404);
});

// WHO, on a project host: `/.itx/session?token=<projectToken>&next=` turns a token for THIS project
// into the host-scoped cookie; every request carrying it reaches the app with `x-itx-principal`; a
// token for another project is refused; a visitor's own `x-itx-principal` is stripped; `?logout`
// clears the cookie.
test("the session door on a project host: a token becomes the cookie, the cookie becomes the principal the app sees", async () => {
  const projectId = freshDnsSafeProjectId("ingress-who");
  const base = projectHostnameBase();
  const itx = openItx(projectId);
  await itx.provide("itx.apps.site", siteRule());
  const host = `site--${projectId}.${base}`;
  const principal = { actor: "user_ada", email: "ada@example.com" };
  const token = await mintProjectToken({ projectId, ...principal });

  const door = await fetchProjectHost(host, `/.itx/session?token=${token}&next=/w`);
  expect(door.status, door.text).toBe(303);
  expect(door.headers.location).toBe("/w");
  const cookie = door.headers["set-cookie"];
  expect(cookie).toContain(`itx-project-session=${token}`);
  expect(cookie).toContain("HttpOnly");

  const cookieHeader = cookie.split(";")[0];
  const seen = JSON.parse((await fetchProjectHost(host, "/echo", { cookie: cookieHeader })).text);
  expect(seen.principal).toEqual(principal);
  // without the cookie there is no principal; a visitor cannot stamp one
  const forged = JSON.parse(
    (
      await fetchProjectHost(host, "/echo", {
        "x-itx-principal": JSON.stringify({ actor: "mallory" }),
      })
    ).text,
  );
  expect(forged.principal).toBeNull();
  // a token for another project is refused at the door
  const foreign = await mintProjectToken({ projectId: `${projectId}-other`, ...principal });
  expect((await fetchProjectHost(host, `/.itx/session?token=${foreign}&next=/`)).status).toBe(401);
  // logout clears the cookie
  const out = await fetchProjectHost(host, "/.itx/session?logout&next=/");
  expect(out.status).toBe(303);
  expect(out.headers["set-cookie"]).toContain("Max-Age=0");
});

test.skipIf(projectHostsAreLocal())(
  "deployed: a WebSocket upgrade on the project host reaches the app",
  async () => {
    const projectId = freshDnsSafeProjectId("ingress-ws");
    const itx = openItx(projectId);
    await itx.provide("itx.apps.site", siteRule());
    const ws = new WebSocket(`wss://site--${projectId}.${projectHostnameBase()}/ws`);
    const echo = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no echo within 10 s")), 10_000);
      ws.addEventListener("open", () => ws.send("hi"));
      ws.addEventListener("message", (event) => {
        clearTimeout(timer);
        resolve(String(event.data));
      });
      ws.addEventListener("error", () => reject(new Error("WebSocket error")));
    });
    ws.close(1000, "done");
    expect(echo).toBe("site-echo:hi");
  },
);
