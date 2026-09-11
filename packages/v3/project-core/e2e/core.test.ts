import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { RpcStub } from "capnweb";
import type { EventPage as Page, Scope, WorkerTarget } from "../src/types.ts";
import {
  base,
  browserHeaders,
  call,
  project,
  session,
  setting,
  socket as connect,
  timeout,
} from "./support.ts";

function input(id: string, type: string, data: unknown): Record<string, unknown> {
  return { id, type, data };
}
function mount(name: string, source: string) {
  return setting(`mount-${name}`, `mount/${name}`, {
    kind: "worker",
    source: { modules: { "main.js": source } },
  });
}
function commit(id: string, content: string, parent: string | null, message: string) {
  return input(id, "repo.commit", {
    name: "site",
    files: { "main.js": content },
    parent,
    message,
  });
}

function page(value: unknown): Page {
  assert.ok(value && typeof value === "object");
  const candidate = value as Partial<Page>;
  assert.ok(Array.isArray(candidate.events));
  assert.equal(typeof candidate.afterOffset, "number");
  assert.equal(typeof candidate.throughOffset, "number");
  assert.equal(typeof candidate.head, "number");
  return candidate as Page;
}

async function readPage(id: string, path = "/") {
  return page(await call(id, ["readEvents"], [{ afterOffset: 0, limit: 128 }], 200, path));
}

async function nextMessage(socket: WebSocket): Promise<Page> {
  const [message] = await once(socket, "message", { signal: AbortSignal.timeout(timeout) });
  return page(JSON.parse(String(message.data)));
}

describe("project core public surface", { concurrency: false, skip: !base }, () => {
  test(
    "one fetch policy selects confined destinations and preserves WebSockets",
    { timeout },
    async (t) => {
      const id = project("one-fetch");
      const app = `export default { async fetch(request, env) {
      const path = new URL(request.url).pathname;
      if (path === '/out') return fetch('https://example.com/');
      if (path === '/relay-socket') {
        const url = new URL(request.url); url.pathname = '/socket';
        return fetch(new Request(url, request));
      }
      if (path === '/socket') {
        const pair = new WebSocketPair(); pair[1].accept();
        pair[1].addEventListener('message', event => pair[1].send('docs:' + event.data));
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      return new Response('docs:' + request.headers.get('x-policy') + ':' + typeof env.NEXT);
    } }`;
      const policy = `export default { async fetch(request, env) {
      const url = new URL(request.url);
      if (url.hostname === '${id}.iterate') {
        const headers = new Headers(request.headers); headers.set('x-policy', 'one');
        const target = await env.NEXT.to({ kind: 'worker', source: { modules: { 'main.js': ${JSON.stringify(app)} } } });
        return target.fetch(new Request(request, { headers }));
      }
      if (url.origin === 'https://example.com') {
        const target = await env.NEXT.to({ kind: 'network', approval: { approval: 'required', expiresInMs: 60000 } });
        return target.fetch(request);
      }
      return new Response('denied by the one policy', { status: 403 });
    } }`;
      await call(id, ["append"], [mount("fetch", policy)]);
      const inside = await fetch(`${base}/p/${id}/docs`, { headers: browserHeaders });
      assert.equal(await inside.text(), "docs:one:undefined");
      const outside = await fetch(`${base}/p/${id}/out`, { headers: browserHeaders });
      assert.equal(outside.status, 202);
      assert.equal(((await outside.json()) as { code: string }).code, "APPROVAL_REQUIRED");
      using context = session<Scope>(id);
      const denied = await context.fetch(new Request("https://unlisted.example/"));
      assert.equal(denied.status, 403);
      assert.equal(await denied.text(), "denied by the one policy");
      for (const path of ["socket", "relay-socket"]) {
        const socket = connect(`${base!.replace(/^http/, "ws")}/p/${id}/${path}`);
        t.after(async () => {
          if (socket.readyState === WebSocket.OPEN) socket.close(1000, "test cleanup");
        });
        await once(socket, "open", { signal: AbortSignal.timeout(timeout) });
        const echoed = once(socket, "message", { signal: AbortSignal.timeout(timeout) });
        socket.send("collaboration");
        assert.equal(String((await echoed)[0].data), "docs:collaboration");
        const closed = once(socket, "close", { signal: AbortSignal.timeout(timeout) });
        socket.close(1000, "test complete");
        const [event] = await closed;
        assert.equal(event.code, 1000, event.reason);
      }
    },
  );

  test(
    "classifies unavailable fetch policy and repository source at every entry",
    { timeout },
    async () => {
      const id = project("fetch-faults");
      using context = session<Scope>(id);
      using worker = await context.load({
        compatibilityDate: "2026-09-04",
        mainModule: "main.js",
        modules: { "main.js": "export default { fetch(request) { return fetch(request); } }" },
      });
      const entries = [
        () =>
          fetch(`${base}/p/${id}/docs`, {
            headers: browserHeaders,
            signal: AbortSignal.timeout(timeout),
          }),
        () => context.fetch(new Request(`https://${id}.iterate/docs`)),
        () => worker.fetch(new Request(`https://${id}.iterate/docs`)),
      ];
      for (const entry of entries) {
        const response = await entry();
        assert.equal(response.status, 404);
        assert.equal(
          ((await response.json()) as { error: { code: string } }).error.code,
          "FETCH_POLICY_UNCONFIGURED",
        );
      }
      await call(
        id,
        ["append"],
        [
          setting("not-worker", "mount/fetch", {
            kind: "context",
            path: "/other",
            member: ["fetch"],
          }),
        ],
      );
      for (const entry of entries) {
        const response = await entry();
        assert.equal(response.status, 400);
        assert.equal(
          ((await response.json()) as { error: { code: string } }).error.code,
          "FETCH_TARGET",
        );
      }
      const missing = { repo: "missing", revision: "0".repeat(64) };
      await call(
        id,
        ["append"],
        [
          setting("missing-policy", "mount/fetch", {
            kind: "worker",
            source: missing,
          }),
        ],
      );
      for (const entry of entries) {
        const response = await entry();
        assert.equal(response.status, 404);
        assert.equal(
          ((await response.json()) as { error: { code: string } }).error.code,
          "REVISION_NOT_FOUND",
        );
      }
      await call(
        id,
        ["append"],
        [
          {
            ...mount(
              "fetch",
              `export default { async fetch(request, env) {
      const target = await env.NEXT.to({ kind: 'worker', source: ${JSON.stringify(missing)} });
      return target.fetch(request);
    } }`,
            ),
            id: "missing-destination",
          },
        ],
      );
      for (const entry of entries) {
        const response = await entry();
        assert.equal(response.status, 404);
        assert.equal(
          ((await response.json()) as { error: { code: string } }).error.code,
          "REVISION_NOT_FOUND",
        );
      }
    },
  );

  test("makes append idempotent and rejects an id collision", { timeout }, async () => {
    const id = project();
    const event = input("once", "note", { value: 1 });
    const original = await call(id, ["append"], [event]);
    assert.deepEqual(await call(id, ["append"], [event]), original);
    const collision = await call(id, ["append"], [input("once", "note", { value: 2 })], 409);
    assert.equal((collision as { code: string }).code, "ID_CONFLICT");
    const events = (await readPage(id)).events;
    assert.equal(events.length, 1);
    assert.deepEqual(events, original, "append, retry, and replay must return the same envelope");
  });

  test("rolls back a batch when its second repository CAS conflicts", { timeout }, async () => {
    const id = project();
    const commits = [
      commit("one", "first", null, "first"),
      commit("two", "second", null, "second"),
    ];
    const conflict = await call(id, ["append"], [commits], 409);
    assert.equal((conflict as { code: string }).code, "REPO_HEAD_CONFLICT");
    assert.deepEqual(await call(id, ["repos", "list"], []), []);
    assert.equal((await readPage(id)).events.length, 0);
  });

  test("commits, reads, and advances immutable repository revisions", { timeout }, async () => {
    const id = project();
    await call(id, ["append"], [commit("first", "export default 1", null, "first")]);
    const first = (await call(id, ["repos", "head"], ["site"])) as { revision: string };
    const firstRead = await call(id, ["repos", "read"], ["site"]);
    assert.deepEqual(firstRead, {
      name: "site",
      revision: first.revision,
      parent: null,
      message: "first",
      files: { "main.js": "export default 1" },
    });
    await call(id, ["append"], [commit("second", "export default 2", first.revision, "second")]);
    const second = (await call(id, ["repos", "head"], ["site"])) as { revision: string };
    assert.notEqual(second.revision, first.revision);
    assert.deepEqual(await call(id, ["repos", "read"], ["site", first.revision]), firstRead);
    assert.deepEqual(await call(id, ["repos", "list"], []), [second]);
  });

  test("normalizes nested paths and keeps contexts isolated", { timeout }, async () => {
    const id = project();
    await call(
      id,
      ["append"],
      [input("support", "note", { where: "support" })],
      200,
      "/team/../support",
    );
    await call(id, ["append"], [input("root", "note", { where: "root" })]);
    const support = await readPage(id, "/support");
    assert.equal(support.events.length, 1);
    assert.deepEqual(support.events[0].data, { where: "support" });
    assert.equal((await readPage(id, "/team")).events.length, 0);
    assert.equal((await readPage(id)).events.length, 1);
    assert.equal(typeof (await call(id, ["inspect"], [], 200, "/support")), "object");
  });

  test("rejects caller-supplied stored metadata", { timeout }, async () => {
    const id = project();
    const invalid = await call(
      id,
      ["append"],
      [
        {
          ...input("stamped", "note", { value: "safe" }),
          context: "forged",
          offset: 999,
          time: 0,
          verification: { level: 99 },
        },
      ],
      400,
    );
    assert.equal((invalid as { code: string }).code, "VALIDATION");
    assert.equal((await readPage(id)).events.length, 0);
  });

  test(
    "runs a configured native worker and gives it its context capability",
    { timeout },
    async () => {
      const id = project();
      const source = `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Hello extends WorkerEntrypoint {
  async boom() { throw new Error("fixture mounted rejection"); }
  async greet(name) {
    const context = await this.env.ITX.get();
    await context.append({ id: "greet-" + name, type: "hello/greeted", data: { name } });
    return "Hello, " + name + "!";
  }
}`;
      await call(id, ["append"], [mount("hello", source)]);
      assert.equal(await call(id, ["hello", "greet"], ["Ada"]), "Hello, Ada!");
      // The runtime-log acceptance probe separately asserts that these leave no hung sessions.
      for (let attempt = 0; attempt < 3; attempt++) {
        const failure = await call(id, ["hello", "boom"], [], 500);
        assert.equal((failure as { code: string }).code, "INTERNAL");
      }
      assert.equal(await call(id, ["hello", "greet"], ["Grace"]), "Hello, Grace!");
      const events = (await readPage(id)).events;
      assert.ok(
        events.some(
          (event) =>
            event.type === "hello/greeted" &&
            JSON.stringify(event.data) === JSON.stringify({ name: "Ada" }),
        ),
      );
    },
  );

  test(
    "loads native-shaped code with custom modules and context-owned ITX",
    { timeout },
    async () => {
      const id = project();
      using context = session<Scope>(id, "/review");
      const code = {
        compatibilityDate: "2026-09-04",
        mainModule: "entry.mjs",
        modules: {
          "entry.mjs": {
            js: `import { WorkerEntrypoint } from "cloudflare:workers";
import text from "./message.txt";
export default class Example extends WorkerEntrypoint {
  async describe() {
    const context = await (await this.env.ITX.get()).inspect();
    return [text, this.env.GREETING, context.context.path];
  }
}`,
          },
          "message.txt": { text: "native text module" },
        },
        env: { GREETING: "Hello", ITX: "caller cannot choose this" },
      };
      using worker = await context.load(code);
      assert.deepEqual(await worker.invoke(["describe"]), [
        "native text module",
        "Hello",
        "/review",
      ]);
      using cached = (await context.invoke(["workers", "get"], {
        modules: {
          "main.js": 'export default { fetch() { return new Response("cached source"); } }',
        },
      })) as RpcStub<WorkerTarget>;
      assert.equal(
        await (await cached.fetch(new Request("https://demo.iterate/"))).text(),
        "cached source",
      );
    },
  );

  test(
    "streams concurrent appends within the configured backlog budget",
    { timeout },
    async (t) => {
      const id = project();
      const socket = connect(`${base!.replace(/^http/, "ws")}/events?project=${id}`);
      t.after(() => socket.close());
      await once(socket, "open", { signal: AbortSignal.timeout(timeout) });
      const data = { text: "x".repeat(1024) };
      const batches = Array.from({ length: 16 }, (_, writer) =>
        Array.from({ length: 100 }, (_, index) => input(`${writer}-${index}`, "note", data)),
      );
      const streamed: Page["events"][number][] = [];
      let backlog = 0;
      const reading = (async () => {
        while (streamed.length < 1600) {
          const current = await nextMessage(socket);
          assert.equal(current.afterOffset, streamed.length);
          streamed.push(...current.events);
          assert.equal(current.throughOffset, streamed.length);
          backlog = Math.max(backlog, current.head - current.throughOffset);
          socket.send(JSON.stringify({ afterOffset: current.throughOffset }));
        }
      })();
      const [, receipts] = await Promise.all([
        reading,
        Promise.all(batches.map((batch) => call(id, ["append"], [batch]))),
      ]);
      const records = (receipts as Page["events"][]).flat().sort((a, b) => a.offset - b.offset);
      assert.deepEqual(streamed, records);
      assert.deepEqual(
        streamed.map((event) => event.id).sort(),
        batches
          .flat()
          .map((event) => event.id)
          .sort(),
      );
      const limit = Number(process.env.LIVE_READER_MAX_BACKLOG?.trim() || 1600);
      assert.ok(
        Number.isSafeInteger(limit) && backlog <= limit,
        `live backlog ${backlog} exceeds ${limit}`,
      );
    },
  );

  test(
    "expires stalled subscriptions, preserves healthy readers, and replays after reconnect",
    { timeout: 40_000 },
    async (t) => {
      const id = project();
      await call(id, ["append"], [input("streamed", "note", { value: "stream" })]);
      const url = new URL("/events", base);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("project", id);
      url.searchParams.set("path", "/");
      url.searchParams.set("afterOffset", "0");
      const sockets = Array.from({ length: 64 }, () => connect(url.href));
      t.after(() => sockets.forEach((socket) => socket.close()));
      const pages = await Promise.all(sockets.map(nextMessage));
      assert.ok(pages.every((page) => page.events.length === 1 && page.throughOffset === 1));
      const healthy = sockets[0]!;
      const closes = Promise.all(
        sockets
          .slice(1)
          .map((socket) => once(socket, "close", { signal: AbortSignal.timeout(35_000) })),
      );
      healthy.send(JSON.stringify({ afterOffset: 1 }));
      const next = nextMessage(healthy);
      await call(id, ["append"], [input("second", "note", { value: "still live" })]);
      assert.equal((await next).throughOffset, 2);
      healthy.send(JSON.stringify({ afterOffset: 2 }));
      const deadline = Date.now() + 25_000;
      while (sockets.slice(1).some((socket) => socket.readyState === WebSocket.OPEN)) {
        assert.ok(Date.now() < deadline, "stalled readers must receive the deadline close");
        await delay(20);
      }
      assert.equal(healthy.readyState, WebSocket.OPEN);
      url.searchParams.set("afterOffset", "1");
      const replacements = Array.from({ length: 63 }, () => connect(url.href));
      sockets.push(...replacements);
      const replay = await Promise.all(replacements.map(nextMessage));
      assert.ok(
        replay.every((page) => page.events.length === 1 && page.events[0]?.id === "second"),
      );
      replacements.forEach((socket) => socket.send(JSON.stringify({ afterOffset: 2 })));
      // workerd can retain native sockets until its 10-second idle teardown after CLOSE.
      for (const [closed] of await closes) {
        assert.equal(closed.code, 1008);
        assert.equal(closed.reason, "Stream acknowledgement deadline exceeded");
      }
    },
  );

  test("blocks fetch-gate bypass from callers and loaded workers", { timeout }, async () => {
    const id = project();
    const app =
      'import { WorkerEntrypoint } from "cloudflare:workers"; export default class App extends WorkerEntrypoint { async fetch(request) { const path = new URL(request.url).pathname; if (path === "/egress") { const response = await fetch("https://example.com/", { headers: { "x-core-below-fetch": "attempted-bypass" } }); return Response.json({ egressStatus: response.status }) } return Response.json({ path, gate: request.headers.get("x-e2e-gate"), below: request.headers.get("x-core-below-fetch") }) } }';
    const gate = `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Gate extends WorkerEntrypoint { async fetch(request) {
  const url = new URL(request.url); const context = await this.env.ITX.get();
  await context.append({ id: "gate-" + url.hostname, type: "gate/seen", data: { hostname: url.hostname } });
  const headers = new Headers(request.headers); headers.set("x-e2e-gate", "entered");
  const target = await this.env.NEXT.to(url.hostname === '${id}.iterate'
    ? { kind: 'worker', source: { modules: { 'main.js': ${JSON.stringify(app)} } } }
    : { kind: 'network', approval: { approval: 'none' } });
  const response = await target.fetch(new Request(request, { headers }));
  const responseHeaders = new Headers(response.headers); responseHeaders.set("x-e2e-gate", "entered");
  return new Response(response.body, { status: response.status, headers: responseHeaders });
} }`;
    await call(id, ["append"], [mount("fetch", gate)]);
    const response = await fetch(new URL(`/p/${id}/from-public`, base), {
      headers: {
        ...browserHeaders,
        "x-core-below-fetch": "attempted-bypass",
        "x-core-terminal": '{"policyOffset":1,"approval":{"approval":"none"}}',
      },
      signal: AbortSignal.timeout(timeout),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-e2e-gate"), "entered");
    assert.deepEqual(await response.json(), {
      path: "/from-public",
      gate: "entered",
      below: null,
    });
    const egress = await fetch(new URL(`/p/${id}/egress`, base), {
      headers: browserHeaders,
      signal: AbortSignal.timeout(timeout),
    });
    assert.equal(egress.status, 200);
    assert.equal(egress.headers.get("x-e2e-gate"), "entered");
    assert.deepEqual(await egress.json(), { egressStatus: 200 });
    using context = session<Scope>(id);
    const code = {
      compatibilityDate: "2026-09-04",
      mainModule: "main.js",
      modules: { "main.js": "export default { fetch(request) { return fetch(request); } }" },
      globalOutbound: null, // Even an untyped caller cannot replace the context's gate.
    };
    using direct = await context.load(code);
    const outbound = await direct.fetch(new Request("https://example.com/"));
    assert.equal(outbound.headers.get("x-e2e-gate"), "entered");
    await outbound.body?.cancel();
    const hosts = (await readPage(id)).events
      .filter((event) => event.type === "gate/seen")
      .map((event) => (event.data as { hostname: string }).hostname);
    assert.ok(hosts.includes("example.com"));
  });
});
