// ingress-project-host.e2e.test.ts — PROJECT-HOST INGRESS (src/worker.ts), the one HTTP way into a
// project: an app is served at `/` on `<app>--<project>.<base>` and `<app>.<project>.<base>` with the
// URL verbatim, so its relative asset loads from the same host; inbound `x-itx-*` never reach it and
// `x-iterate-app` is the label the host selected, whatever a visitor sent; the apex `<project>.<base>`
// names no app and lands on the config worker's `fetch` (the bundled default: 404; a project's own
// routes it); a label with no rule is a 404; and — deployed — an upgrade rides through the host to the
// app. The app is one rule row: the log never names a hostname. WHO, on a host: an OAuth bearer stamps the verified
// principal; credentials never reach the app. Browser cookie flows are in specs/os/auth.spec.ts. RED, deployed: the hop budget counts only
// what an app forwards — an app fetching its own host with a FRESH Request is not stopped by it.

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
  localOnly,
  projectHostsAreLocal,
  projectUrl,
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
  const slug = freshDnsSafeProjectSlug("ingress");
  const projectId = await registerProject(slug);
  const itx = openItx(projectId);
  await itx.provide("itx.apps.site", siteRule());
  const site = (path: string) => projectUrl({ project: slug, app: "site", path });
  /** what the app sees of `path`: host, path and query (under paths, the project prefix stripped) */
  const sees = (path: string) => {
    const seen = appSeesUrl({ project: slug, app: "site", path });
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
  // a visitor's x-itx-* never reach the app (the lane's own header is set after the strip), and
  // x-iterate-app is the label the address selected — a visitor's own is overwritten at the DO's fetch
  // lane, from the expression
  const echo = await fetchProjectUrl(site("/echo"), {
    "x-itx-expression": "itx.kv",
    "x-itx-visitor": "1",
    "x-iterate-app": "other",
  });
  const seen = JSON.parse(echo.text) as { url: string; itxHeaders: string[]; app: string | null };
  expect(seen.url).toContain(`//${sees("/echo")}`);
  expect(seen.itxHeaders).not.toContain("x-itx-expression");
  expect(seen.itxHeaders).not.toContain("x-itx-visitor");
  expect(seen).toMatchObject({ app: "site" });
  // the second app shape, `<app>.<project>.<base>`: the same row. LOCAL ONLY: a wildcard
  // certificate covers ONE label under the base (`*.project-worker.iterate.com`), and a wildcard
  // never matches two, so on the deployed worker this shape fails the TLS handshake until a
  // certificate per project subdomain exists — a deploy-side fact, not the edge's (the workers lane
  // pins the parse; this pins the whole edge, where it can be reached).
  const routing = ingressRouting();
  if (projectHostsAreLocal() && routing?.type === "subdomains") {
    const dotted = await fetchProjectHost(`site.${slug}.${routing.hostname}`, "/w");
    expect(dotted, dotted.text).toMatchObject({ status: 200 });
    expect(dotted.text).toContain(`<p>site.${slug}.${routing.hostname}/w</p>`);
  }
  // An apex with no site yet is 404. Publishing the router sends requests to
  // `itx.apps.site.fetch`, which derives `x-iterate-app` from that expression.
  // The wrapper's forwarded headers cannot override the resolved app label.
  const apexRoot = projectUrl({ project: slug, path: "/" });
  const bare = await fetchProjectUrl(apexRoot);
  expect(bare, bare.text).toMatchObject({ status: 404 });
  expect(bare.text).toMatch(/no site yet/);
  await itx.append({
    type: "events.iterate.com/project/ingress-configured",
    payload: {
      target: [
        "itx",
        "workers",
        ["get", { source: SRC_CONFIG_ROUTER, cacheKey: "config:ingress" }],
      ],
    },
  });
  const apex = await fetchProjectUrl(apexRoot, { "x-iterate-app": "other" });
  expect(apex, apex.text).toMatchObject({ status: 200 });
  expect(apex.text).toContain("<title>site</title>");
  // a path ON the apex reaches the config worker too — under subdomains: under paths the segment after
  // `/projects/<slug>/` is an APP label, so the apex has its root alone (the paths design's one gap)
  if (routing?.type === "subdomains") {
    const echoed = await fetchProjectHost(`${slug}.${routing.hostname}`, "/echo", {
      "x-iterate-app": "other",
    });
    expect(echoed, echoed.text).toMatchObject({ status: 200 });
    expect(JSON.parse(echoed.text)).toMatchObject({ app: "site" });
  }
  // a label no rule serves is the lane's 404 (NO_ITX_EXPRESSION_MATCH), never a 500
  const missing = await fetchProjectUrl(projectUrl({ project: slug, app: "other", path: "/" }));
  expect(missing, missing.text).toMatchObject({ status: 404 });
});

// A CUSTOM HOSTNAME (`urls.temporaryCustomHostnames`, worker-config.ts: `custom-apex.test` ⇒
// `custom-apex-project`) is that project's apex outside the base: the config worker's `fetch`
// answers, the same row a `<project>.<base>` apex lands on. LOCAL ONLY: the deployed map is prd's
// (`iterate.com` ⇒ the `iterate` project), proven by hand against iterate.com.
localOnly(
  "a custom hostname is a project's apex: the config worker's fetch answers it",
  async () => {
    const projectId = await registerProject("custom-apex-project"); // the slug worker-config.ts maps custom-apex.test to
    const itx = openItx(projectId);
    await itx.provide("itx.apps.site", siteRule());
    // A custom hostname reaches its project, but needs an explicit ingress target.
    const bare = await fetchProjectHost("custom-apex.test", "/");
    expect(bare, bare.text).toMatchObject({ status: 404 });
    expect(bare.text).toMatch(/no site yet/);
    await itx.append({
      type: "events.iterate.com/project/ingress-configured",
      payload: {
        target: [
          "itx",
          "workers",
          ["get", { source: SRC_CONFIG_ROUTER, cacheKey: "config:custom-apex" }],
        ],
      },
    });
    const apex = await fetchProjectHost("custom-apex.test", "/echo");
    expect(apex, apex.text).toMatchObject({ status: 200 });
    expect((JSON.parse(apex.text) as { url: string }).url).toContain("//custom-apex.test/echo");
    // a hostname the map does not name is not a project host (nor the platform origin): 421
    const unknown = await fetchProjectHost("other-apex.test", "/");
    expect(unknown, unknown.text).toMatchObject({ status: 421 });
  },
);

test("a project host verifies an OAuth bearer, strips credentials and rejects a grant for another project", async () => {
  const slug = freshDnsSafeProjectSlug("ingress-who");
  const member = { email: `${slug}@example.com` };
  const projectId = await registerProject(slug, member);
  const itx = openItx(projectId);
  await itx.provide("itx.apps.site", siteRule());
  const echoUrl = projectUrl({ project: slug, app: "site", path: "/echo" });
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
createFailing(
  test.skipIf(projectHostsAreLocal() || !SELF_LOOP_OPT_IN),
  /TimeoutError: The operation was aborted due to timeout/,
  { timeoutMs: 60_000, retries: process.env.CI ? E2E_CI_RETRIES : 0 },
)(
  "an app that fetches its own host with a FRESH Request is stopped by the hop budget (508 on the fourth pass)",
  async () => {
    const slug = freshDnsSafeProjectSlug("ingress-loop");
    const itx = openItx(await registerProject(slug));
    await itx.provide("itx.apps.loop", ["itx", "workers", ["get", { source: SRC_SELF_LOOP }]]);
    const answer = await fetch(projectUrl({ project: slug, app: "loop", path: "/" }), {
      signal: AbortSignal.timeout(10_000),
    });
    expect(answer).toMatchObject({ status: 508 });
  },
);

deployedOnly("deployed: a WebSocket upgrade on the project host reaches the app", async () => {
  const slug = freshDnsSafeProjectSlug("ingress-ws");
  const itx = openItx(await registerProject(slug));
  await itx.provide("itx.apps.site", siteRule());
  const ws = new WebSocket(
    projectUrl({ project: slug, app: "site", path: "/ws" }).href.replace(/^http/, "ws"),
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
});

// ADMISSION: a hostname for a project the control plane's catalog does not know is
// 421 at the edge, before any project Durable Object is dialled — a stranger's label under the
// wildcard mints nothing.
test("an address for a project the catalog does not know is 421, and its label is never an app", async () => {
  const unknown = freshDnsSafeProjectSlug("ingress-unknown"); // never registered
  const answer = await fetchProjectUrl(projectUrl({ project: unknown, app: "site", path: "/" }));
  expect(answer, answer.text).toMatchObject({ status: 421 });
  expect(answer.text).toContain(unknown);
});

const siteRule = () => ["itx", "workers", ["get", { source: SRC_SITE }]];
