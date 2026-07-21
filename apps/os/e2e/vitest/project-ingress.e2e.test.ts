import { request as httpRequest } from "node:http";
import { expect, test } from "vitest";
import WebSocket from "ws";
import type { StreamSubscriberWakeRequest, StreamSubscriberWakeResponse } from "iterate/processors";
import type { StatefulDynamicWorkerRef } from "iterate/sdk";
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
  // The homepage links to each seeded app on its own host: the current host
  // prefixed with "<app>--".
  const requestHost = new URL(buildUrl({ path: "/" })).host;
  expect(homepage).toContain(`hello--${requestHost}`);
  expect(homepage).toContain(`counter--${requestHost}`);
});

// Multi-app routing: the seeded root worker.ts is a router over the project's
// apps (repo-backed dynamic workers), selected by ingress from the host —
// hello--<slug>.<base> (stateless WorkerEntrypoint) and counter.<slug>.<base>
// (stateful Durable Object whose state survives across requests). Locally the
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
      createApp: {
        client: "apps/guestbook/client.tsx",
        files: { repoPath: "/repos/config", type: "repo" },
        server: "apps/guestbook/server.tsx",
      },
    },
    type: "stateful",
  } satisfies StatefulDynamicWorkerRef;
  using directGuestbook = project.workers.get(guestbookAppRef) as unknown as {
    processor: {
      wakeStreamSubscriber(
        request: StreamSubscriberWakeRequest,
      ): Promise<StreamSubscriberWakeResponse>;
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
    directGuestbook.processor.wakeStreamSubscriber({
      processorSlug: "guestbook",
      stream: { path: "/wrong-stream", projectId, streamMaxOffset: 2 },
      subscriptionKey: "app-guestbook#guestbook",
    }),
  ).rejects.toThrow("wakeStreamSubscriber coordinate mismatch");

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

  // Stateless app via the `--` single-label form; a spoofed x-iterate-app
  // must not override the host's selection.
  const hello = await fetchAppReady(`hello--${slug}`, {
    headers: { "x-iterate-app": "counter" },
  });
  expect(hello).toMatchObject({ status: 200 });
  expect(await hello.json()).toMatchObject({ app: "hello", projectId });

  // Stateful app: a mini client-side counter page — the count renders
  // server-side, the button POSTs /increment (JSON), and live updates ride
  // the /ws WebSocket (proven in the websocket test below) — with Durable
  // Object state surviving across requests. (The single-label `--` form is
  // the one platform wildcard certs can serve — dotted `<app>.<slug>.<base>`
  // needs a second wildcard level and is exercised in the unit tests +
  // reserved for custom hostnames.)
  const page = await fetchAppReady(`counter--${slug}`);
  expect(page).toMatchObject({ status: 200 });
  expect(await page.text()).toContain('count: <span id="n">0</span>');

  const increment = await fetchApp(`counter--${slug}`, {
    method: "POST",
    path: "/increment",
  });
  expect(increment).toMatchObject({ status: 200 });
  expect(await increment.json()).toEqual({ count: 1 });

  await fetchApp(`counter--${slug}`, { method: "POST", path: "/increment" });
  const read = await fetchApp(`counter--${slug}`);
  expect(await read.text()).toContain('count: <span id="n">2</span>');

  // createApp compiles the browser entry at its unchanged repo path, resolves
  // ordinary package.json dependencies (including iterate/sdk/capnweb/react),
  // and lets worker-bundler's asset handler serve the result.
  const guestbook = await fetchAppReady(`guestbook--${slug}`);
  expect(guestbook).toMatchObject({ status: 200 });
  const guestbookHtml = await guestbook.text();
  expect(guestbookHtml).toContain("<title>Guestbook</title>");
  expect(guestbookHtml).toContain(
    '<script type="module" src="/apps/guestbook/client.js"></script>',
  );
  expect(guestbookHtml).toContain("__iterateWorkerOverlay");
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
      "apps/todo/client.tsx",
      "apps/todo/server.tsx",
      "package.json",
      "worker.ts",
    ]),
  });
  // The hello/counter examples are named exports; the basic browser apps each
  // have one server and one client entry.
  expect(tree.paths).not.toContain("sdk.ts");
  expect(await project.repo.readFile({ path: "nope.md" })).toBeNull();

  // Unknown apps 404 in the router itself.
  const unknown = await fetchApp(`nope--${slug}`);
  expect(unknown).toMatchObject({ status: 404 });
  expect(await unknown.text()).toContain("unknown app");
});

// WebSocket upgrades through project ingress into the seeded counter app.
// This is the regression proof for the fetch-native dispatch lane: an
// upgrade's 101 response cannot cross RPC method calls (workerd
// DataCloneError on the socket), so ingress, the userspace router
// (env.ITX.fetch + x-iterate-worker-dispatch), the stateful worker DO, and
// the facet must all forward it over real fetch hops. Locally the app host
// rides on the HTTP Host header (Node cannot resolve *.localhost); against a
// deployed preview the real wildcard hostname is dialed directly.
test("counter websockets: upgrade flows through ingress and increments broadcast live", async () => {
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
  const appHost = `counter--${slug}`;
  const localHostHeader = `${appHost}.localhost${base.port ? `:${base.port}` : ""}`;

  const connect = () =>
    isLocal
      ? new WebSocket(`ws://${base.host}/ws`, {
          headers: { host: localHostHeader },
        })
      : new WebSocket(`wss://${appHost}.${projectBase}/ws`);

  const postIncrement = () =>
    isLocal
      ? fetchWithHostHeader(new URL(buildUrl({ path: "/increment" })), localHostHeader, {
          method: "POST",
        })
      : fetch(`${base.protocol}//${appHost}.${projectBase}/increment`, { method: "POST" });

  const openSocket = (ws: WebSocket) =>
    new Promise<WebSocket>((resolve, reject) => {
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });

  const nextMessage = (ws: WebSocket) =>
    new Promise<string>((resolve, reject) => {
      ws.once("message", (data) => resolve(String(data)));
      ws.once("error", reject);
      ws.once("close", (code) => reject(new Error(`socket closed (${code})`)));
    });

  // The app's first use is a cold build; the router answers upgrades with a
  // retryable 503 until the artifact lands, so "the socket opens" means
  // "eventually opens through the building responses" — the same reconnect
  // loop a browser client runs.
  const openSocketReady = async () => {
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        return await openSocket(connect());
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  };

  // Every new socket is greeted with the current count, so a fresh tab is
  // correct before anyone clicks.
  const first = await openSocketReady();
  try {
    expect(await nextMessage(first)).toBe("0");
    const second = await openSocketReady();
    try {
      expect(await nextMessage(second)).toBe("0");

      // One HTTP increment broadcasts to BOTH sockets — the live-update lane
      // and the proof both sockets terminate in the SAME Durable Object
      // instance (shared live state).
      const firstSaw = nextMessage(first);
      const secondSaw = nextMessage(second);
      const incremented = await postIncrement();
      expect(incremented).toMatchObject({ status: 200 });
      expect(await firstSaw).toBe("1");
      expect(await secondSaw).toBe("1");
    } finally {
      second.close();
    }
  } finally {
    first.close();
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
