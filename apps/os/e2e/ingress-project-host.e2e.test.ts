// ingress-project-host.e2e.test.ts — PROJECT-HOST INGRESS (src/worker.ts), the one HTTP way into a
// project: EVERY host of a project — `<routingSlug>--<project>.<base>`, `<routingSlug>.<project>.<base>`
// and the apex `<project>.<base>` — reaches the project's config worker `fetch` with the URL verbatim,
// so a relative asset loads from the same host; inbound `x-itx-*` never reach it and
// `x-iterate-routing-slug` is the slug the host names (absent on the apex), whatever a visitor sent;
// a routing slug the config worker does not serve reaches it too, and its 404 is the config worker's;
// and — deployed — an upgrade rides through the host to the config worker. The log never names a
// hostname. WHO, on a host: an OAuth bearer stamps the verified principal; credentials never reach the
// config worker. Browser cookie flows are in specs/os/auth.spec.ts. RED, deployed: the hop budget
// counts only what a site forwards — a site fetching its own host with a FRESH Request is not stopped by it.

import { expect, test } from "vitest";
import { E2E_CI_RETRIES } from "@iterate-com/shared/test-support/e2e-policy";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { openItx } from "./support/client.ts";
import { oauthSession } from "./support/principal.ts";
import {
  appSeesUrl,
  deployedOnly,
  fetchProjectHost,
  fetchProjectUrl,
  freshDnsSafeProjectSlug,
  ingressRouting,
  projectHostsAreLocal,
  projectUrl,
  publishConfigWorker,
  registerProject,
} from "./support/project-host.ts";

/** A config worker routing in plain code: the apex and the `site` routing slug serve the site — HTML
 *  at `/` with a RELATIVE script, the script at `/app.js`, an echo of what it was handed at `/echo`,
 *  and a WebSocket echo on an upgrade — and any other routing slug is its own 404, naming the slug. */
const SRC_SITE = {
  "cap.js": String.raw`import { WorkerEntrypoint } from "cloudflare:workers";
export default class Site extends WorkerEntrypoint {
  fetch(request) {
    const url = new URL(request.url);
    const routingSlug = request.headers.get("x-iterate-routing-slug");
    if (routingSlug !== null && routingSlug !== "site")
      return new Response("the config worker serves no " + routingSlug + "\n", { status: 404 });
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
        routingSlug,
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

test("every host of a project reaches its config worker — URL verbatim, relative asset intact, x-itx-* stripped, x-iterate-routing-slug the host's (absent on the apex) whatever a visitor sent; both shapes; an unknown routing slug reaches the config worker too", async () => {
  const slug = freshDnsSafeProjectSlug("ingress");
  const projectId = await registerProject(slug);
  const itx = openItx(projectId);
  await publishConfigWorker(itx, siteTarget());
  const site = (path: string) => projectUrl({ project: slug, routingSlug: "site", path });
  /** what the config worker sees of `path`: host, path and query (under paths, the prefix stripped) */
  const sees = (path: string) => {
    const seen = appSeesUrl({ project: slug, routingSlug: "site", path });
    return `${seen.host}${seen.pathname}${seen.search}`;
  };

  // the page, with the URL it was asked for
  const page = await fetchProjectUrl(site("/w?repo=x"));
  expect(page, page.text).toMatchObject({ status: 200 });
  expect(page.headers["content-type"]).toContain("text/html");
  expect(page.text).toContain(`<p>${sees("/w?repo=x")}</p>`);
  // the page's relative script resolves beside it
  const asset = await fetchProjectUrl(site("/app.js"));
  expect(asset, asset.text).toMatchObject({ status: 200 });
  expect(asset.text).toContain("document.title");
  // a visitor's x-itx-* never reach the config worker (the expression fetch's own header is set after
  // the strip), and x-iterate-routing-slug is the slug the address named — a visitor's own is
  // overwritten by the edge
  const echo = await fetchProjectUrl(site("/echo"), {
    "x-itx-expression": "itx.kv",
    "x-itx-visitor": "1",
    "x-iterate-routing-slug": "other",
  });
  const seen = JSON.parse(echo.text) as {
    url: string;
    itxHeaders: string[];
    routingSlug: string | null;
  };
  expect(seen.url).toContain(`//${sees("/echo")}`);
  expect(seen.itxHeaders).not.toContain("x-itx-expression");
  expect(seen.itxHeaders).not.toContain("x-itx-visitor");
  expect(seen).toMatchObject({ routingSlug: "site" });
  // the second shape, `<routingSlug>.<project>.<base>`: the same config worker. LOCAL ONLY: a wildcard
  // certificate covers ONE label under the base (`*.iterate.app`), and a wildcard
  // never matches two, so on the deployed worker this shape fails the TLS handshake until a
  // certificate per project subdomain exists — a deploy-side fact, not the edge's (the Workers suite
  // pins the parse; this pins the whole edge, where it can be reached).
  const routing = ingressRouting();
  if (projectHostsAreLocal() && routing?.type === "subdomains") {
    const dotted = await fetchProjectHost(`site.${slug}.${routing.hostname}`, "/w");
    expect(dotted, dotted.text).toMatchObject({ status: 200 });
    expect(dotted.text).toContain(`<p>site.${slug}.${routing.hostname}/w</p>`);
  }
  // the apex is the same config worker, with no routing slug — a visitor's is deleted by the edge
  const apexRoot = projectUrl({ project: slug, path: "/" });
  const apex = await fetchProjectUrl(apexRoot, { "x-iterate-routing-slug": "site" });
  expect(apex, apex.text).toMatchObject({ status: 200 });
  expect(apex.text).toContain("<title>site</title>");
  // a path ON the apex reaches the config worker too — under subdomains: under paths the segment after
  // `/projects/<slug>/` is a ROUTING SLUG, so the apex has its root alone (the paths design's one gap)
  if (routing?.type === "subdomains") {
    const echoed = await fetchProjectHost(`${slug}.${routing.hostname}`, "/echo", {
      "x-iterate-routing-slug": "site",
    });
    expect(echoed, echoed.text).toMatchObject({ status: 200 });
    expect(JSON.parse(echoed.text)).toMatchObject({ routingSlug: null });
  }
  // a routing slug the config worker does not serve still reaches it, the header set: its own 404
  const missing = await fetchProjectUrl(
    projectUrl({ project: slug, routingSlug: "other", path: "/" }),
  );
  expect(missing).toMatchObject({ status: 404, text: "the config worker serves no other\n" });
});

test("a project host verifies an OAuth bearer, strips credentials and rejects a grant for another project", async () => {
  const slug = freshDnsSafeProjectSlug("ingress-who");
  const member = { email: `${slug}@example.com` };
  const projectId = await registerProject(slug, member);
  const itx = openItx(projectId);
  await publishConfigWorker(itx, siteTarget());
  const echoUrl = projectUrl({ project: slug, routingSlug: "site", path: "/echo" });
  const { token, principal } = await oauthSession(projectId, member);
  const echo = await fetchProjectUrl(echoUrl, {
    Authorization: `Bearer ${token}`,
    cookie: "theme=dark",
    "x-itx-principal": '{"actor":"forged"}',
  });
  expect(echo, echo.text).toMatchObject({ status: 200 });
  const seen = JSON.parse(echo.text);
  expect(seen).toMatchObject({ principal, cookie: "theme=dark" });
  expect(seen.authorization).toBeNull();
  const forged = await fetchProjectUrl(echoUrl, { "x-itx-principal": '{"actor":"forged"}' });
  expect(JSON.parse(forged.text).principal).toBeNull();
  const other = await registerProject(freshDnsSafeProjectSlug("ingress-foreign"), member);
  const foreign = await oauthSession(other, member);
  expect(
    await fetchProjectUrl(echoUrl, { Authorization: `Bearer ${foreign.token}` }),
  ).toMatchObject({ status: 403 });
});

/** A config worker that fetches its own host with a FRESH Request — nothing forwarded, so no hop count. */
const SRC_SELF_LOOP = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Loop extends WorkerEntrypoint {
  fetch(request) { return fetch(new Request(request.url)); }
}`,
};

// RED BY CONSTRUCTION: the hop budget (src/worker.ts `PROJECT_HOST_HOPS_HEADER`) is the count the
// site FORWARDS — a site that fetches its own host with a fresh Request re-enters at 1 every pass,
// and the fourth pass is never reached. Deployed only: the local DO's fetch cannot resolve a
// `*.localhost` host. OPT-IN (RUN_SELF_LOOP_PROBE=1), like the wake-loop probe: the row starts a
// REAL self-nesting chain on the deployed worker that runs until the eyeball's 10 s abort — never
// in a routine deployed run.
const SELF_LOOP_OPT_IN = process.env.RUN_SELF_LOOP_PROBE === "1";
createFailing(
  test.skipIf(projectHostsAreLocal() || !SELF_LOOP_OPT_IN),
  /TimeoutError: The operation was aborted due to timeout/,
  { timeoutMs: 60_000, retries: process.env.CI ? E2E_CI_RETRIES : 0 },
)(
  "a site that fetches its own host with a FRESH Request is stopped by the hop budget (508 on the fourth pass)",
  async () => {
    const slug = freshDnsSafeProjectSlug("ingress-loop");
    const itx = openItx(await registerProject(slug));
    await publishConfigWorker(itx, ["itx", "workers", ["get", { source: SRC_SELF_LOOP }]]);
    const answer = await fetch(projectUrl({ project: slug, path: "/" }), {
      signal: AbortSignal.timeout(10_000),
    });
    expect(answer).toMatchObject({ status: 508 });
  },
);

deployedOnly(
  "deployed: a WebSocket upgrade on the project host reaches the config worker",
  async () => {
    const slug = freshDnsSafeProjectSlug("ingress-ws");
    const itx = openItx(await registerProject(slug));
    await publishConfigWorker(itx, siteTarget());
    const ws = new WebSocket(
      projectUrl({ project: slug, routingSlug: "site", path: "/ws" }).href.replace(/^http/, "ws"),
    );
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

// ADMISSION: a hostname for a project the control plane's catalog does not know is
// 421 at the edge, before any project Durable Object is dialled — a stranger's label under the
// wildcard mints nothing.
test("an address for a project the catalog does not know is 421, whatever its routing slug", async () => {
  const unknown = freshDnsSafeProjectSlug("ingress-unknown"); // never registered
  const answer = await fetchProjectUrl(
    projectUrl({ project: unknown, routingSlug: "site", path: "/" }),
  );
  expect(answer, answer.text).toMatchObject({ status: 421 });
  expect(answer.text).toContain(unknown);
});

const siteTarget = () => ["itx", "workers", ["get", { source: SRC_SITE }]];
