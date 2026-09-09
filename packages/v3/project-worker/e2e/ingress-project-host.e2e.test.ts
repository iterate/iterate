// ingress-project-host.e2e.test.ts — PROJECT-HOST INGRESS (src/worker.ts), the one HTTP way into a
// project: an app is served at `/` on `<app>--<project>.<base>` and `<app>.<project>.<base>` with the
// URL verbatim, so its relative asset loads from the same host; inbound `x-itx-*` never reach it and
// `x-iterate-app` is the label the host selected, whatever a visitor sent; the apex `<project>.<base>`
// names no app and lands on the config worker's `fetch` (the bundled default: 404; a project's own
// routes it); a label with no rule is a 404; and — deployed — an upgrade rides through the host to the
// app. The app is one rule row: the log never names a hostname. WHO, on a host: a project token a
// member minted becomes the `/.itx/session` cookie and stamps `x-itx-principal`; the platform's
// credential never reaches the app (the bearer lanes — a token, the admin secret, the project's own
// secret — are __workers-tests__/session-doors.test.ts). RED, deployed: the hop budget counts only
// what an app forwards — an app fetching its own host with a FRESH Request is not stopped by it.

import { expect, test } from "vitest";
import { openItx } from "./support/client.ts";
import { mintProjectToken } from "./support/principal.ts";
import {
  deployedOnly,
  fetchProjectHost,
  freshDnsSafeProjectId,
  projectHostnameBase,
  projectHostsAreLocal,
  registerProject,
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
        app: request.headers.get("x-iterate-app"),
        principal: JSON.parse(request.headers.get("x-itx-principal") || "null"),
        cookie: request.headers.get("cookie"),
        authorization: request.headers.get("authorization"),
      });
    return new Response(
      "<!doctype html><title>site</title><script src=\"app.js\"></script><p>" +
        url.host + url.pathname + url.search + "</p>",
      { headers: { "content-type": "text/html" } },
    );
  }
}`,
};

const siteRule = () => ["itx", "workers", ["get", { source: SRC_SITE }]];

/** A project's own config worker: `fetch` routes the apex host to the `site` app — the tutorial's
 *  shape (sdk/index.ts `ConfigWorker`). */
const SRC_CONFIG_ROUTER = {
  "cap.js": `import { ConfigWorker } from "./processor.js";
export default class extends ConfigWorker {
  fetch(request) {
    return this.env.ITX.get().apps.site.fetch(request);
  }
}`,
};

test("an app is served at / on its project host — URL verbatim, relative asset intact, x-itx-* stripped, x-iterate-app the host's label; both app shapes; the apex is the config worker's fetch; a label with no rule is 404", async () => {
  const projectId = freshDnsSafeProjectId("ingress");
  await registerProject(projectId);
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
  // a visitor's x-itx-* never reach the app (the lane's own header is set after the strip), and
  // x-iterate-app is the label the host selected — a visitor's own is overwritten at the DO's fetch
  // lane, from the expression
  const echo = await fetchProjectHost(host, "/echo", {
    "x-itx-expression": "itx.kv",
    "x-itx-visitor": "1",
    "x-iterate-app": "other",
  });
  const seen = JSON.parse(echo.text) as { url: string; itxHeaders: string[]; app: string | null };
  expect(seen.url).toContain(`//${host}/echo`);
  expect(seen.itxHeaders).not.toContain("x-itx-expression");
  expect(seen.itxHeaders).not.toContain("x-itx-visitor");
  expect(seen.app).toBe("site");
  // the second app shape, `<app>.<project>.<base>`: the same row. LOCAL ONLY: a wildcard
  // certificate covers ONE label under the base (`*.project-worker.iterate.com`), and a wildcard
  // never matches two, so on the deployed worker this shape fails the TLS handshake until a
  // certificate per project subdomain exists — a deploy-side fact, not the edge's (the workers lane
  // pins the parse; this pins the whole edge, where it can be reached).
  if (projectHostsAreLocal()) {
    const dotted = await fetchProjectHost(`site.${projectId}.${base}`, "/w");
    expect(dotted.status, dotted.text).toBe(200);
    expect(dotted.text).toContain(`<p>site.${projectId}.${base}/w</p>`);
  }
  // the apex names no app: the config worker's fetch answers it — the bundled default is 404, a
  // project's own routes it (here: to the site, through `itx.apps.site.fetch`), and the site then
  // sees ITS label: the DO's fetch lane derives `x-iterate-app` from the expression at every door,
  // never from what the config worker forwarded (the config worker itself sees none — the workers lane)
  const bare = await fetchProjectHost(`${projectId}.${base}`, "/");
  expect(bare.status, bare.text).toBe(404);
  expect(bare.text).toContain("Not found");
  await itx.provide("itx.worker", [
    "itx",
    "workers",
    ["get", { source: SRC_CONFIG_ROUTER, cacheKey: "config:ingress" }],
  ]);
  const apex = await fetchProjectHost(`${projectId}.${base}`, "/echo", {
    "x-iterate-app": "other",
  });
  expect(apex.status, apex.text).toBe(200);
  expect((JSON.parse(apex.text) as { app: string | null }).app).toBe("site");
  // a label no rule serves is the lane's 404 (NO_ITX_EXPRESSION_MATCH), never a 500
  const missing = await fetchProjectHost(`other--${projectId}.${base}`, "/");
  expect(missing.status, missing.text).toBe(404);
});

// WHO, on a project host: `/.itx/session?token=<projectToken>&next=` turns a token for THIS project
// into the host-scoped cookie; every request carrying it reaches the app with `x-itx-principal`; a
// token for another project is refused; a visitor's own `x-itx-principal` is stripped; `POST
// ?logout` clears the cookie (a GET is 405).
test("the session door on a project host: a token becomes the cookie, the cookie becomes the principal the app sees", async () => {
  const projectId = freshDnsSafeProjectId("ingress-who");
  const email = `${projectId}@example.com`;
  const ada = { email };
  await registerProject(projectId, ada); // her project: she mints her own token through the door
  const base = projectHostnameBase();
  const itx = openItx(projectId);
  await itx.provide("itx.apps.site", siteRule());
  const host = `site--${projectId}.${base}`;
  const principal = { actor: `user_${email}`, email };
  const token = await mintProjectToken(projectId, ada);

  const door = await fetchProjectHost(host, `/.itx/session?token=${token}&next=/w`);
  expect(door.status, door.text).toBe(303);
  expect(door.headers.location).toBe("/w");
  const cookie = door.headers["set-cookie"];
  expect(cookie).toContain(`__Host-itx-project-session=${token}`);
  expect(cookie).toContain("HttpOnly");

  const cookieHeader = cookie.split(";")[0];
  const seen = JSON.parse(
    (await fetchProjectHost(host, "/echo", { cookie: `${cookieHeader}; theme=dark` })).text,
  );
  expect(seen.principal).toEqual(principal);
  // the app (loaded code) sees the verified stamp, never the platform's cookie — the visitor's own
  // cookies still reach it
  expect(seen.cookie).toBe("theme=dark");
  // the door's redirect never leaves the host
  expect(
    (
      await fetchProjectHost(
        host,
        "/.itx/session?logout&next=//evil.example/x",
        {},
        {
          method: "POST",
        },
      )
    ).headers.location,
  ).toBe("/");
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
  const foreign = await mintProjectToken(`${projectId}-other`);
  expect((await fetchProjectHost(host, `/.itx/session?token=${foreign}&next=/`)).status).toBe(401);
  // logout is a POST (a GET cannot end a session) and clears the cookie
  expect((await fetchProjectHost(host, "/.itx/session?logout&next=/")).status).toBe(405);
  const out = await fetchProjectHost(host, "/.itx/session?logout&next=/", {}, { method: "POST" });
  expect(out.status).toBe(303);
  expect(out.headers["set-cookie"]).toContain("Max-Age=0");
});

/** An app that fetches its own host with a FRESH Request — nothing forwarded, so no hop count. */
const SRC_SELF_LOOP = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Loop extends WorkerEntrypoint {
  fetch(request) { return fetch(new Request(request.url)); }
}`,
};

// RED BY CONSTRUCTION: the hop budget (src/worker.ts `PROJECT_HOST_HOPS_HEADER`) is the count the
// app FORWARDS — an app that fetches its own host with a fresh Request re-enters at 1 every pass,
// and the fourth pass is never reached. Deployed only: the local DO's fetch cannot resolve a
// `*.localhost` host. OPT-IN (RUN_SELF_LOOP_PROBE=1), like the wake-loop probe: the row starts a
// REAL self-nesting chain on the deployed worker that runs until the eyeball's 10 s abort — never
// in a routine deployed run.
const SELF_LOOP_OPT_IN = process.env.RUN_SELF_LOOP_PROBE === "1";
test
  .skipIf(projectHostsAreLocal() || !SELF_LOOP_OPT_IN)
  .fails(
    "an app that fetches its own host with a FRESH Request is stopped by the hop budget (508 on the fourth pass)",
    async () => {
      const projectId = freshDnsSafeProjectId("ingress-loop");
      await registerProject(projectId);
      const itx = openItx(projectId);
      await itx.provide("itx.apps.loop", ["itx", "workers", ["get", { source: SRC_SELF_LOOP }]]);
      const answer = await fetch(`https://loop--${projectId}.${projectHostnameBase()}/`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(answer.status).toBe(508);
    },
  );

deployedOnly("deployed: a WebSocket upgrade on the project host reaches the app", async () => {
  const projectId = freshDnsSafeProjectId("ingress-ws");
  await registerProject(projectId);
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
});

// ADMISSION (wave 0, issue 1): a hostname for a project the directory does not know is 421 at the
// edge, before any Durable Object is dialled — a stranger's label under the wildcard mints nothing.
test("a host for a project the directory does not know is 421, and its label is never an app", async () => {
  const unknown = freshDnsSafeProjectId("ingress-unknown"); // never registered
  const answer = await fetchProjectHost(`site--${unknown}.${projectHostnameBase()}`, "/");
  expect(answer.status, answer.text).toBe(421);
  expect(answer.text).toContain(unknown);
});
