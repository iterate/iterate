import { request as httpRequest } from "node:http";
import { expect, test } from "vitest";
import WebSocket from "ws";
import type { StreamProcessorWakeRequest, StreamProcessorWakeResponse } from "iterate/processors";
import type { StatefulDynamicWorkerRef } from "iterate/sdk";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, buildUrl, withItxSession } from "./test-helpers.ts";

/** The Response surface these tests read — what both lanes of fetchApp
 * return (a real Response deployed, the node:http shim locally). */
type AppResponse = {
  headers: Headers;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

test("project ingress serves the static seeded homepage at the root", async () => {
  const marker = crypto.randomUUID();

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects.get(`project-ingress-${marker}`).create({});
  const { projectId } = await project.__describe();

  const pageResponse = await fetch(buildUrl({ path: `/${projectId}` }));
  expect(pageResponse).toMatchObject({ status: 200 });
  const homepage = await pageResponse.text();
  expect(homepage).toContain("Hello from your iterate project worker");
  // The seeded homepage intentionally omits <head>; ingress still supplies a
  // default user-space icon after checking the whole document for app icons.
  expect(homepage).toContain(
    `href="/${projectId}/.iterate/favicon.svg" data-iterate-default-favicon`,
  );
  const favicon = await fetch(buildUrl({ path: `/${projectId}/.iterate/favicon.svg` }));
  expect(favicon).toMatchObject({ status: 200 });
  expect(favicon.headers.get("content-type")).toContain("image/svg+xml");
  expect(await favicon.text()).toContain('fill="white"');
  // The homepage links to each seeded app on its own host: the current host
  // prefixed with "<app>--".
  const requestHost = new URL(buildUrl({ path: "/" })).host;
  expect(homepage).toContain(`todo--${requestHost}`);
  expect(homepage).toContain(`guestbook--${requestHost}`);
});

// Multi-app routing: the seeded root worker.ts is a router over the project's
// apps (repo-backed dynamic workers), selected by ingress from the host
// (guestbook--<slug>.<base>, a packaged stateful Durable Object). Locally the
// app host rides on the HTTP Host header via node:http (see
// fetchWithHostHeader); against a deployed preview the real wildcard
// hostnames are used.
test("routes seeded apps by host and serves worker-bundler browser assets", async () => {
  const marker = crypto.randomUUID().slice(0, 8);
  const slug = `multi-app-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects.get(slug).create({});
  const { projectId } = await project.__describe();

  // The app owns its birth invariant even when called directly, before the
  // userspace root route has had an opportunity to initialize the stream.
  const guestbookAppRef = {
    className: "GuestbookApp",
    durableWorkerKey: "app-guestbook-stream",
    path: "/",
    source: {
      createWorker: {
        entryPoint: "node_modules/iterate/dist/starter-apps/guestbook/configured-worker.mjs",
        files: {
          include: ["package.json"],
          repoPath: "/repos/config",
          type: "repo",
        },
      },
    },
    type: "stateful",
  } satisfies StatefulDynamicWorkerRef;
  using directGuestbook = project.workers.get(guestbookAppRef) as unknown as {
    getState(): Promise<{ entries: { message: string; name: string }[] }>;
    processor: {
      wakeStreamProcessor(
        request: StreamProcessorWakeRequest,
      ): Promise<StreamProcessorWakeResponse>;
    };
    sign(name: string, message: string): Promise<void>;
  } & Disposable;
  await expect(
    directGuestbook.sign("Direct caller", "Born before routing"),
  ).resolves.toBeUndefined();
  using guestbookStream = project.streams.get("/guestbook");
  expect(
    (await guestbookStream.getEvents())
      .map(({ type }) => type)
      .filter((type) => type.startsWith("events.iterate.com/guestbook/")),
  ).toEqual(["events.iterate.com/guestbook/created", "events.iterate.com/guestbook/entry-signed"]);
  // The wake expression uses workers.get(ref)'s default member replay. Its
  // intermediate `processor` property must therefore survive Workers RPC as
  // a real RpcTarget; reaching the registry's coordinate fence proves that
  // exact lane without opening a live delivery sink in the test.
  await expect(
    directGuestbook.processor.wakeStreamProcessor({
      processorSlug: "guestbook",
      stream: {
        path: "/wrong-stream",
        projectId,
        streamId: crypto.randomUUID(),
        streamMaxOffset: 2,
      },
      name: "guestbook",
    }),
  ).rejects.toThrow("wakeStreamProcessor coordinate mismatch");
  const externalName = `External ${marker}`;
  await guestbookStream.append({
    type: "events.iterate.com/guestbook/entry-signed",
    payload: { message: "Delivered by ProjectWorker.processEvent", name: externalName },
    idempotencyKey: `guestbook/external:${marker}`,
  });
  await waitForCondition(
    async () =>
      (await directGuestbook.getState()).entries.some(({ name }) => name === externalName),
    {
      description: "the packaged Guestbook to process an externally appended event",
      intervalMs: 250,
      timeoutMs: 30_000,
    },
  );

  const fetchApp = (
    appHostPrefix: string,
    init?: RequestInit & { path?: string },
  ): Promise<AppResponse> => {
    const path = init?.path ?? "/";
    const base = new URL(buildUrl({ path }));
    if (base.hostname === "localhost" || base.hostname.endsWith(".localhost")) {
      return fetchWithHostHeader(
        base,
        `${appHostPrefix}.localhost${base.port ? `:${base.port}` : ""}`,
        init,
      );
    }
    // The deployment's project hosts live on APP_CONFIG_PROJECT_HOSTNAME_BASES
    // (a JSON array — config.ts z.array; e.g. ["iterate.app"] for prd) — fall
    // back to the preview-derivation only when the env var is absent.
    const raw = process.env.APP_CONFIG_PROJECT_HOSTNAME_BASES?.trim();
    const configuredBase = raw ? String((JSON.parse(raw) as string[])[0]) : undefined;
    const previewMatch = /^os\.(iterate-preview-\d+)\.com$/.exec(base.hostname);
    const projectBase = configuredBase || (previewMatch ? `${previewMatch[1]}.app` : base.hostname);
    return fetch(`${base.protocol}//${appHostPrefix}.${projectBase}${path}`, init);
  };

  // An app's first use is a cold build; past the router's buildBudgetMs it
  // serves a refreshing 503 building page instead of blocking, so "the app
  // responds" means "eventually 200 through the building page".
  const fetchAppReady = async (appHostPrefix: string, init?: RequestInit & { path?: string }) => {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const response = await fetchApp(appHostPrefix, init);
      if (response.status !== 503 || Date.now() > deadline) return response;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  };

  // The packaged physical worker serves its embedded browser entry. The app rides
  // the `--` single-label host form (the one platform wildcard certs can
  // serve), and a spoofed x-iterate-app header must not override the host's
  // selection.
  const guestbook = await fetchAppReady(`guestbook--${slug}`, {
    headers: { "x-iterate-app": "todo" },
  });
  expect(guestbook).toMatchObject({ status: 200 });
  const guestbookHtml = await guestbook.text();
  expect(guestbookHtml).toContain("<title>Guestbook</title>");
  expect(guestbookHtml).toContain("data-iterate-default-favicon");
  expect(guestbookHtml).toContain(
    '<script type="module" src="/apps/guestbook/client.js"></script>',
  );
  expect(guestbookHtml).toContain("data-iterate-worker-overlay");
  const guestbookClient = await fetchApp(`guestbook--${slug}`, {
    path: "/apps/guestbook/client.js",
  });
  expect(guestbookClient).toMatchObject({ status: 200 });
  expect(guestbookClient.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
  const guestbookClientSource = await guestbookClient.text();
  expect(guestbookClientSource).not.toContain("esm.sh");
  expect(guestbookClientSource).toContain("useLiveState needs <CapnWebProvider>");

  // The seeded repo is readable through the itx repo capability.
  const workerSource = await project.repo.readFile({ path: "worker.ts" });
  expect(workerSource?.content).toContain("export default class ProjectWorker");
  const tree = await project.repo.listFiles();
  expect(tree).toMatchObject({
    paths: expect.arrayContaining([
      "AGENTS.md",
      "apps/guestbook/client.tsx",
      "apps/guestbook/server.tsx",
      "package.json",
      "worker.ts",
    ]),
  });
  expect(tree.paths.some((path) => path.startsWith("apps/review-bot/"))).toBe(false);
  expect(tree.paths).not.toContain("sdk.ts");
  expect(await project.repo.readFile({ path: "nope.md" })).toBeNull();

  // Unknown apps 404 in the router itself.
  const unknown = await fetchApp(`nope--${slug}`);
  expect(unknown).toMatchObject({ status: 404 });
  expect(await unknown.text()).toContain("unknown app");
});

// WebSocket upgrades through project ingress into the seeded guestbook app's
// Cap'n Web /api. This is the regression proof for the fetch-native dispatch
// lane: an upgrade's 101 response cannot cross RPC method calls (workerd
// DataCloneError on the socket), so ingress, the userspace router
// (env.ITX.fetch + x-iterate-worker-dispatch), the packaged app DO, and the
// facet must all forward it over real fetch hops. (The live snapshot/patch
// traffic that rides this socket is proven browser-side in
// specs/seeded-apps.spec.ts.) Locally the app host rides on the HTTP Host
// header (Node cannot resolve *.localhost); against a deployed preview the
// real wildcard hostname is dialed directly.
test("guestbook websocket: the /api upgrade flows through ingress into the app DO", async () => {
  const marker = crypto.randomUUID().slice(0, 8);
  const slug = `ws-app-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects.get(slug).create({});
  await project.__describe();

  const base = new URL(buildUrl({ path: "/" }));
  const isLocal = base.hostname === "localhost" || base.hostname.endsWith(".localhost");
  const raw = process.env.APP_CONFIG_PROJECT_HOSTNAME_BASES?.trim();
  const configuredBase = raw ? String((JSON.parse(raw) as string[])[0]) : undefined;
  const previewMatch = /^os\.(iterate-preview-\d+)\.com$/.exec(base.hostname);
  const projectBase = configuredBase || (previewMatch ? `${previewMatch[1]}.app` : base.hostname);
  const appHost = `guestbook--${slug}`;
  const localHostHeader = `${appHost}.localhost${base.port ? `:${base.port}` : ""}`;

  const connect = () =>
    isLocal
      ? new WebSocket(`ws://${base.host}/api`, {
          headers: { host: localHostHeader },
        })
      : new WebSocket(`wss://${appHost}.${projectBase}/api`);

  const openSocket = (ws: WebSocket) =>
    new Promise<WebSocket>((resolve, reject) => {
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });

  // The app's first use is a cold build; the router answers upgrades with a
  // retryable 503 until the artifact lands, so "the socket opens" means
  // "eventually opens through the building responses" — the same reconnect
  // loop a browser client runs.
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const socket = await openSocket(connect());
      socket.close();
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
});

/**
 * The local lane's HTTP client. App hosts are selected by hostname
 * (`hello--<slug>.localhost`), but Node's fetch (undici) silently drops a
 * `host` header override (spec-forbidden) and nothing resolves
 * `*.localhost` — so local requests dial the dev server's address directly
 * and speak the app host via the Host header, which plain node:http allows.
 * Never follows redirects, matching the redirect assertions here.
 */
function fetchWithHostHeader(
  target: URL,
  hostHeader: string,
  init?: { headers?: HeadersInit; method?: string },
): Promise<AppResponse> {
  return new Promise((resolve, reject) => {
    const headers = new Headers(init?.headers);
    headers.set("host", hostHeader);
    const request = httpRequest(
      {
        headers: Object.fromEntries(headers),
        host: target.hostname,
        method: init?.method ?? "GET",
        path: `${target.pathname}${target.search}`,
        port: target.port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === "string") responseHeaders.set(name, value);
            else if (Array.isArray(value)) responseHeaders.set(name, value.join(", "));
          }
          resolve({
            headers: responseHeaders,
            json: async () => JSON.parse(body) as unknown,
            status: response.statusCode ?? 0,
            text: async () => body,
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}
