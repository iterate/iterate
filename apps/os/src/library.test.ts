// library.test.ts — the library's executable spec, one describe per concept (each over its own fake `itx`),
// plus THE LIBRARY RULE pinned over the library files' imports (the last block).

import { readFileSync, readdirSync } from "node:fs";
import { RpcTarget, newHttpBatchRpcResponse } from "capnweb";
import { expect, onTestFinished, test, vi } from "vitest";
import { codedError } from "iterate/lib";
import type { WaitForEventFilter } from "iterate/api";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import {
  buildLibrary,
  type LibraryItx,
  type LibraryRoots,
  executeScript,
  RUN_DEADLINE_MS,
  runScript,
  runScriptModule,
  runSettlementOf,
} from "./library.ts";
import { connectToCapnweb } from "./library/capnweb.ts";
import { connectToMcp, type McpConnectionRpcTarget } from "./library/mcp.ts";
import { connectToOpenApi, type OpenApiDocument } from "./library/openapi.ts";

// ── the library ── the memo `buildLibrary` keeps over the three verbs: a connect with the same
// (verb, url, options) is ONE live connection for the context's life; `releaseConnections()` (the
// pins' release's call) closes what it holds and the next use reopens; a connect that FAILS is never
// kept. ONE fake `itx.fetch` serves all three remotes by host and records every handshake.

const REMOTES_SPEC: OpenApiDocument = {
  openapi: "3.0.0",
  servers: [{ url: "https://api.example/v1" }],
  paths: { "/me": { get: { operationId: "me" } } },
};

const verbs: {
  verb: string;
  connect: (roots: LibraryRoots) => Promise<unknown>;
  /** The request a connect makes — one per LIVE connection (the batch transport makes none). */
  handshake?: string;
}[] = [
  {
    verb: "connectToMcp",
    connect: (roots) => roots.connectToMcp("https://mcp.example/", { headers: { a: "1" } }),
    handshake: "initialize",
  },
  {
    verb: "connectToOpenApi",
    connect: (roots) => roots.connectToOpenApi("https://api.example/openapi.json"),
    handshake: "GET /openapi.json",
  },
  {
    verb: "connectToCapnweb",
    connect: (roots) => roots.connectToCapnweb("https://rpc.example/rpc", { transport: "batch" }),
  },
];
for (const { verb, connect, handshake } of verbs)
  test(`buildLibrary memoizes live connections per context: ${verb}: two connects with the same arguments are ONE connection — the same object back, one handshake`, async () => {
    const { itx, seen } = remotes();
    const { roots } = buildLibrary(itx, { caller: () => ({ principal: null }), path: "/" });
    const a = await connect(roots);
    const b = await connect(roots);
    expect(b).toBe(a);
    if (handshake) expect(seen.filter((m) => m === handshake)).toHaveLength(1);
  });

test("buildLibrary memoizes live connections per context: releaseConnections closes what it holds (MCP: the session's DELETE) and forgets it; the next connect is a fresh handshake, a new object, and works", async () => {
  const { itx, seen } = remotes();
  const { roots, releaseConnections } = buildLibrary(itx, {
    caller: () => ({ principal: null }),
    path: "/",
  });
  const a = await roots.connectToMcp("https://mcp.example/");
  releaseConnections();
  await new Promise((r) => setTimeout(r, 10)); // the close rides a `.then` off the memoized promise
  expect(seen).toContain("DELETE");
  const b = await roots.connectToMcp("https://mcp.example/");
  expect(b).not.toBe(a);
  expect(initializes(seen)).toBe(2);
  expect(await b.callTool("echo", {})).toBe("ok");
});

test("buildLibrary memoizes live connections per context: a held connection reused CONCURRENTLY after close re-handshakes ONCE — no session-less post", async () => {
  // The pins' release closes the memoized client while a caller still holds the connection; its
  // next request re-handshakes. Two concurrent requests must share ONE handshake and neither may
  // post before the session id is established — this fake server delays initialize and rejects a
  // session-less non-initialize (a real MCP server 400s), so a request that skips the shared
  // handshake fails.
  let initializeCount = 0;
  const itx = {
    fetch: async (request: Request) => {
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      const body = JSON.parse(await request.text()) as { id?: number; method: string };
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "initialize") {
        initializeCount++;
        await new Promise((r) => setTimeout(r, 5)); // let a racing request interleave first
        return json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "f" },
            },
          },
          { headers: { "mcp-session-id": "s-1" } },
        );
      }
      if (!request.headers.get("mcp-session-id"))
        return json(
          { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "no session" } },
          { status: 400 },
        );
      const result =
        body.method === "tools/list"
          ? { tools: [{ name: "echo" }] }
          : { content: [{ type: "text", text: '"ok"' }] };
      return json({ jsonrpc: "2.0", id: body.id, result });
    },
  } as unknown as LibraryItx;
  const { roots, releaseConnections } = buildLibrary(itx, {
    caller: () => ({ principal: null }),
    path: "/",
  });
  const conn = await roots.connectToMcp("https://mcp.example/");
  releaseConnections();
  await new Promise((r) => setTimeout(r, 10)); // the close rides a `.then` off the memoized promise
  const [r1, r2] = await Promise.all([conn.callTool("echo", {}), conn.callTool("echo", {})]);
  expect([r1, r2]).toEqual(["ok", "ok"]);
  expect(initializeCount).toBe(2); // one for connect, one shared re-handshake — never a third
});

test("buildLibrary memoizes live connections per context: closing DURING a re-handshake deletes the new session and does not revive the client", async () => {
  let sessions = 0;
  const deletes: string[] = [];
  let releaseHandshake: (() => void) | undefined;
  const itx = {
    fetch: async (request: Request) => {
      if (request.method === "DELETE") {
        deletes.push(request.headers.get("mcp-session-id") ?? "?");
        return new Response(null, { status: 204 });
      }
      const body = JSON.parse(await request.text()) as { id?: number; method: string };
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "initialize") {
        const id = `s-${++sessions}`;
        if (sessions > 1) await new Promise<void>((r) => (releaseHandshake = r)); // park the re-handshake
        return json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "f" },
            },
          },
          { headers: { "mcp-session-id": id } },
        );
      }
      const result =
        body.method === "tools/list"
          ? { tools: [{ name: "echo" }] }
          : { content: [{ type: "text", text: '"ok"' }] };
      return json({ jsonrpc: "2.0", id: body.id, result });
    },
  } as unknown as LibraryItx;
  const { roots, releaseConnections } = buildLibrary(itx, {
    caller: () => ({ principal: null }),
    path: "/",
  });
  const conn = await roots.connectToMcp("https://mcp.example/"); // establishes s-1
  releaseConnections();
  await new Promise((r) => setTimeout(r, 10)); // closes s-1 (DELETE s-1)

  const inflight = conn.callTool("echo", {}).then(
    () => "ok",
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
  await new Promise((r) => setTimeout(r, 10)); // the re-handshake (s-2) is parked
  await conn.close(); // close AGAIN while the handshake is in flight — bumps the generation
  releaseHandshake?.(); // now let the parked handshake complete
  const outcome = await inflight;

  expect(outcome).toMatch(/closed during its handshake/); // the call did not silently succeed
  expect(deletes).toContain("s-1");
  expect(deletes).toContain("s-2"); // the session the losing handshake established was NOT leaked
});

test("buildLibrary memoizes live connections per context: releaseConnections closes a WebSocket capnweb connection LOCALLY — `close` is the connection's own member, never the dotted proxy's remote call", async () => {
  // What egress's 101 would carry: a WebSocket-shaped object capnweb's session can drive.
  const closed: [number | undefined, string | undefined][] = [];
  const sent: string[] = [];
  const webSocket = {
    readyState: 1,
    accept() {},
    send(data: string) {
      sent.push(String(data));
    },
    close(code?: number, reason?: string) {
      closed.push([code, reason]);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const itx = { fetch: async () => ({ status: 101, webSocket }) } as unknown as LibraryItx;
  const { roots, releaseConnections } = buildLibrary(itx, {
    caller: () => ({ principal: null }),
    path: "/",
  });
  await roots.connectToCapnweb("wss://ws.example/rpc");
  releaseConnections();
  await new Promise((r) => setTimeout(r, 10));
  // the LOCAL session was shut down (capnweb closes the socket on disposing the main stub) and
  // nothing rode the wire — the dotted fallback beneath InvokeHandle would have made `close` a
  // remote call on the far side's main object instead, leaving this socket open
  expect(closed).toHaveLength(1);
  expect(sent).toEqual([]);
});

test("buildLibrary memoizes live connections per context: a connect that FAILS is not memoized — the next call retries", async () => {
  let attempts = 0;
  const itx = {
    fetch: async () => {
      attempts += 1;
      return new Response("down", { status: 503 });
    },
  } as unknown as LibraryItx;
  const { roots } = buildLibrary(itx, { caller: () => ({ principal: null }), path: "/" });
  await expect(roots.connectToMcp("https://mcp.example/")).rejects.toThrow(/503/);
  await expect(roots.connectToMcp("https://mcp.example/")).rejects.toThrow(/503/);
  expect(attempts).toBe(2);
});

test("buildLibrary memoizes live connections per context: the memo is keyed by the options too, and two spellings of one options object are one key", async () => {
  const { itx, seen } = remotes();
  const { roots } = buildLibrary(itx, { caller: () => ({ principal: null }), path: "/" });
  const a = await roots.connectToMcp("https://mcp.example/", { headers: { a: "1", b: "2" } });
  const b = await roots.connectToMcp("https://mcp.example/", { headers: { b: "2", a: "1" } });
  const c = await roots.connectToMcp("https://mcp.example/", { headers: { a: "other" } });
  expect(b).toBe(a);
  expect(c).not.toBe(a);
  expect(initializes(seen)).toBe(2);
});

// ── run ── `itx.run(script)` over a fake itx: `run` is a REQUEST on the log (`itx.append`) and a
// wait for ITS settlement (`itx.waitForEvent`), the execution being the context's runner's
// (`executeScript`, over `itx.workers.get`): the module the loader would get (the script spliced
// verbatim, the smallest WorkerEntrypoint around it), run with NO arguments (a script bakes its own
// values in), the same text ⇒ the same module (the loader's content hash reuses the isolate), a
// blank script refused.

test("run: the module: the script spliced in verbatim, a default WorkerEntrypoint whose run() hands it one withItx round trip, with withItx alone beside it", () => {
  const module = runScriptModule("async (itx) => (await itx.whoami()).path");
  expect(module["cap.js"]).toContain('import { WorkerEntrypoint } from "cloudflare:workers"');
  expect(module["cap.js"]).toContain('import { withItx } from "./with-itx.js";');
  expect(module["cap.js"]).toContain("const script = (async (itx) => (await itx.whoami()).path);");
  expect(module["cap.js"]).toContain("export default class extends WorkerEntrypoint");
  expect(module["cap.js"]).toContain("async run() {");
  expect(module["cap.js"]).toContain("return await withItx(this.env.ITX, async (itx) => {");
  expect(module["cap.js"]).toContain("script(itx),");
  expect(module["cap.js"]).not.toContain("ITX.get()");
  expect(Object.keys(module)).toEqual(["cap.js", "with-itx.js"]);
  expect(module["with-itx.js"]).toMatch(/as withItx\b/);
});

test("run: the module's run() races the script against RUN_DEADLINE_MS in its own isolate: a script that never settles is given up on at the deadline — the call ends, the itx is disposed, no timer is left", async () => {
  vi.useFakeTimers();
  try {
    const { run, disposals } = await loadedRun("async () => new Promise(() => {})");
    let outcome: unknown;
    void run().then(
      () => (outcome = "resolved"),
      (error: Error) => (outcome = error.message),
    );
    await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS - 1);
    expect(outcome).toBeUndefined();
    expect(disposals()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("itx.run: the script did not finish within 10 minutes");
    expect(disposals()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("run: the module's run(): a script that finishes (or throws) settles the call at once and clears its deadline", async () => {
  vi.useFakeTimers();
  try {
    const finishes = await loadedRun("async () => 42");
    expect(await finishes.run()).toBe(42);
    expect(finishes.disposals()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    const throws = await loadedRun("async () => { throw new Error('nope') }");
    await expect(throws.run()).rejects.toThrow("nope");
    expect(throws.disposals()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("run: the module's run() releases every call the script made through its scope, awaited or not, and hands back its value as JSON", async () => {
  const released: string[] = [];
  const itx = {
    [Symbol.dispose]: () => released.push("scope"),
    cd: (path: string) =>
      Object.assign(Promise.resolve({ path, live: () => 1 }), {
        [Symbol.dispose]: () => released.push(`cd(${path})`),
      }),
  };
  const { run } = await loadedRun(
    "async (itx) => { itx.cd('/never-awaited'); return await itx.cd('/a'); }",
    itx,
  );
  expect(await run()).toEqual({ path: "/a" }); // the live function dropped, as the log would
  expect(released).toEqual(["cd(/a)", "cd(/never-awaited)", "scope"]);
});

test("run: the module's run() releases a handle the script awaited, and the calls it made on that handle", async () => {
  const released: string[] = [];
  const disposable = <T extends object>(value: T, name: string) =>
    Object.assign(value, { [Symbol.dispose]: () => released.push(name) });
  const handle = disposable(
    Object.assign(() => undefined, {
      whoami: () => disposable(Promise.resolve({ path: "/a" }), "whoami"),
    }),
    "handle",
  );
  const itx = disposable({ cd: () => disposable(Promise.resolve(handle), "cd") }, "scope");
  const { run } = await loadedRun(
    "async (itx) => { const a = await itx.cd('/a'); return (await a.whoami()).path; }",
    itx,
  );
  expect(await run()).toBe("/a");
  expect(released).toEqual(["whoami", "handle", "cd", "scope"]);
});

test("run: executeScript (the runner's call) loads that module through itx.workers.get and calls run() with no arguments", async () => {
  const { itx, loaded, runs } = host();
  await expect(executeScript(itx, "async (itx) => 1")).resolves.toEqual({ calledWith: 0 });
  expect(loaded).toEqual([{ source: runScriptModule("async (itx) => 1") }]);
  expect(runs()).toBe(1);
});

test("run: run(script) appends run-requested { code } — the request's offset IS the run — and waits for ITS run-settled after it: another run's settlement is skipped, a WAIT_TIMEOUT re-arms from the last event seen; resolves with the result; it loads nothing itself", async () => {
  const script = "async (itx) => 1";
  const { itx, loaded, appended, waits, runs } = host([
    settledAt(11, 9, { status: "succeeded", result: 0 }), // another run's (its request at 9)
    "timeout",
    settledAt(13, 10, { status: "succeeded", result: { n: 1 } }), // ours: the request landed at 10
  ]);
  await expect(
    buildLibrary(itx, { caller: () => ({ principal: null }), path: "/" }).roots.run(script),
  ).resolves.toEqual({ n: 1 });
  expect(appended).toEqual([
    { type: "events.iterate.com/context/run-requested", payload: { code: script } },
  ]);
  expect(waits.map((w) => [w.type, w.afterOffset])).toEqual([
    ["events.iterate.com/context/run-settled", 10], // after the request (offset 10)
    ["events.iterate.com/context/run-settled", 11], // the other run's was the last seen
    ["events.iterate.com/context/run-settled", 11], // a timeout re-arms from the same place
  ]);
  expect(loaded).toEqual([]); // the execution is the runner's, never the caller's
  expect(runs()).toBe(0);
});

test("run: the wait is bounded: no settlement a minute past the deadline gives up with WAIT_TIMEOUT, so the caller's call — and the context it holds — is not held open", async () => {
  vi.useFakeTimers();
  try {
    const timeouts: number[] = [];
    const itx = {
      builtins: {
        append: async (...events: StreamEventInput[]) =>
          events.map((event, i) => ({ ...event, offset: 10 + i, createdAt: "t", path: "/" })),
        // A log where no settlement ever lands: every wait times out, on its own timeout.
        waitForEvent: (filter: WaitForEventFilter) => {
          timeouts.push(filter.timeoutMs!);
          return new Promise((_, reject) =>
            setTimeout(() => reject(codedError("WAIT_TIMEOUT", "no event")), filter.timeoutMs),
          );
        },
      },
    } as unknown as LibraryItx;
    let outcome: unknown;
    void runScript(itx, "async () => new Promise(() => {})").catch(
      (error: unknown) => (outcome = error),
    );
    await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS + 60_000 - 1);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toMatchObject({
      code: "WAIT_TIMEOUT",
      message: "itx.run: no settlement of run 10 within 11 minutes",
    });
    // re-armed at the cap, the last wait only for what was left
    expect(timeouts).toEqual([120_000, 120_000, 120_000, 120_000, 120_000, 60_000]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("run: a failed settlement rejects with its error, the failure kind on the rejection", async () => {
  const { itx } = host([
    settledAt(11, 10, { status: "failed", error: "boom", failureKind: "interrupted" }),
  ]);
  await expect(
    buildLibrary(itx, { caller: () => ({ principal: null }), path: "/" }).roots.run(
      "async () => 1",
    ),
  ).rejects.toMatchObject({
    message: "boom",
    failureKind: "interrupted",
  });
});

test("run: the same text is the same module (byte-equal: the loader's content hash keys ONE isolate); a blank script is refused before any request", async () => {
  expect(runScriptModule("async (itx) => 1")).toEqual(runScriptModule("async (itx) => 1"));
  const { itx, loaded, appended } = host();
  await expect(runScript(itx, "   ")).rejects.toThrow(/itx\.run\(script/);
  // wire-fed: a non-string (the array-form expression carries no argument validation) is refused
  // with the same usage error, never a TypeError from `.trim`
  await expect(runScript(itx, 42)).rejects.toThrow(/itx\.run\(script/);
  await expect(runScript(itx, undefined)).rejects.toThrow(/itx\.run\(script/);
  expect(loaded).toEqual([]);
  expect(appended).toEqual([]);
});

// ── the runner's settlement ── `runSettlementOf(execution)`, what the context's runner appends as
// `run-settled` (iterate-context-durable-object.ts `#executeRun`): the value through the JSON
// boundary and RELEASED (a Workers-RPC result carries a disposer holding its callee), or the failure —
// `deadline` once RUN_DEADLINE_MS has passed, whoever gave up first, else `runtime`. Fake timers.

const DEADLINE_ERROR =
  "itx.run: the script did not finish within 10 minutes; it may have partly run, and it is not run again";

test.for([
  ["plain data", { n: 1 }, { status: "succeeded", result: { n: 1 } }],
  [
    "a live value (a function: a stub over RPC — JSON has no text for it)",
    () => 1,
    { status: "succeeded" },
  ],
  ["data carrying a live value", { n: 1, f: () => 1 }, { status: "succeeded", result: { n: 1 } }],
] as const)(
  "the runner's settlement: %s: settled succeeded, the value released exactly once",
  async ([, value, settlement]) => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const result = releasable(value);
    expect(await runSettlementOf(Promise.resolve(result.value))).toEqual(settlement);
    expect(result.releases()).toBe(1);
  },
);

test.for([
  ["undefined: no result", async () => undefined, { status: "succeeded" }],
  ["an empty string is a result", async () => "", { status: "succeeded", result: "" }],
  [
    "a bigint JSON refuses: a runtime failure",
    async () => 10n,
    {
      status: "failed",
      error: "Do not know how to serialize a BigInt",
      failureKind: "runtime",
    },
  ],
  [
    "the script threw",
    async () => {
      throw new Error("nope");
    },
    { status: "failed", error: "nope", failureKind: "runtime" },
  ],
  [
    "a value whose release throws (already released) still settles succeeded",
    async () => ({
      n: 1,
      [Symbol.dispose]: () => {
        throw new Error("RPC stub used after being disposed");
      },
    }),
    { status: "succeeded", result: { n: 1 } },
  ],
] satisfies [string, () => Promise<unknown>, unknown][])(
  "the runner's settlement: %s",
  async ([, execute, settlement]) => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    expect(await runSettlementOf(execute())).toEqual(settlement);
  },
);

test("the runner's settlement: a script still running at RUN_DEADLINE_MS is settled `deadline` then, not a moment before — and nothing is left armed", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  let settlement: unknown;
  void runSettlementOf(new Promise(() => {})).then((settled) => (settlement = settled));
  await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS - 1);
  expect(settlement).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(settlement).toEqual({
    status: "failed",
    error: DEADLINE_ERROR,
    failureKind: "deadline",
  });
  expect(vi.getTimerCount()).toBe(0);
});

test("the runner's settlement: the loaded run() giving up on its own clock (or a redirect's runner on its own) is the deadline too — whoever gives up first — while a failure before it stays `runtime`", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const givesUpAt = (ms: number) =>
    new Promise((_, reject) => setTimeout(() => reject(new Error("gave up")), ms));
  const [atDeadline, before] = [
    runSettlementOf(givesUpAt(RUN_DEADLINE_MS)),
    runSettlementOf(givesUpAt(RUN_DEADLINE_MS - 1)),
  ];
  await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS);
  expect(await atDeadline).toEqual({
    status: "failed",
    error: DEADLINE_ERROR,
    failureKind: "deadline",
  });
  expect(await before).toEqual({ status: "failed", error: "gave up", failureKind: "runtime" });
});

test("the runner's settlement: a value that lands after the deadline is still released", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const late = releasable(() => 1);
  const settlement = runSettlementOf(
    new Promise((resolve) => setTimeout(() => resolve(late.value), RUN_DEADLINE_MS + 5_000)),
  );
  await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS + 5_000);
  expect(await settlement).toMatchObject({ failureKind: "deadline" });
  expect(late.releases()).toBe(1);
});

// ── capnweb ── the batch transport over a fake `itx.fetch` that IS a capnweb server
// (capnweb's own `newHttpBatchRpcResponse`), so a real capnweb round trip runs with no network: the
// handle's dotted sugar, an explicit invoke, and a pipelined chain in one batch. The WebSocket
// transport needs workerd's WebSocketPair and is proved in e2e.

test("connectToCapnweb, batch transport: dotted sugar on the handle reaches the remote main", async () => {
  const { itx, requests } = capnwebItx();
  const conn = await connectToCapnweb(itx, "https://api.example/rpc", {
    transport: "batch",
    headers: { authorization: "Bearer t" },
  });
  expect(await (conn as any).hello("world")).toBe("hello world");
  expect(requests[0]).toMatchObject({ method: "POST" });
  expect(requests[0].headers.get("authorization")).toBe("Bearer t");
});
test("connectToCapnweb, batch transport: an explicit invoke walks the steps; a call-then-call chain pipelines in ONE batch", async () => {
  const { itx, requests } = capnwebItx();
  const conn = await connectToCapnweb(itx, "https://api.example/rpc", { transport: "batch" });
  expect(await conn.invoke([["counter"], ["inc", 5]])).toBe(5);
  expect(requests).toHaveLength(1);
});
test("connectToCapnweb, batch transport: a remote error surfaces as a rejection", async () => {
  const conn = await connectToCapnweb(capnwebItx().itx, "https://api.example/rpc", {
    transport: "batch",
  });
  await expect((conn as any).boom()).rejects.toThrow(/kaboom/);
});
test("connectToCapnweb, batch transport: a non-2xx batch answer rejects with the status", async () => {
  const itx = {
    fetch: async () => new Response("no", { status: 502, statusText: "Bad Gateway" }),
  } as unknown as LibraryItx;
  const conn = await connectToCapnweb(itx, "https://api.example/rpc", { transport: "batch" });
  await expect((conn as any).hello("x")).rejects.toThrow(
    /batch to https:\/\/api.example\/rpc returned 502/,
  );
});

// ── mcp ── the MCP client against a fake server: a `Request → Response` function behind
// a fake `itx.fetch`, recording every request. Rows, not prose.

type Handler = (request: Request, body: any) => Response | Promise<Response>;

const TOOLS = [
  { name: "echo", description: "echo the args", inputSchema: { type: "object" } },
  { name: "add", inputSchema: { type: "object" } },
  { name: "callTool", inputSchema: {} }, // a reserved name: reachable through callTool only
];

test("connectToMcp: connect: initialize → initialized → tools/list, the session id riding on every later request", async () => {
  const { itx, requests } = mcpItx(referenceServer());
  const conn = await connectToMcp(itx, "https://mcp.example/rpc", {
    headers: { authorization: "Bearer t" },
  });
  expect(requests.map((r) => r.body?.method)).toEqual([
    "initialize",
    "notifications/initialized",
    "tools/list",
  ]);
  expect(requests[0].body.params).toMatchObject({ protocolVersion: "2025-03-26" });
  expect(requests[0].request.headers.get("authorization")).toBe("Bearer t");
  expect(requests[0].request.headers.get("accept")).toBe("application/json, text/event-stream");
  expect(requests[2].request.headers.get("mcp-session-id")).toBe("s-1");
  expect(conn.serverInfo()).toMatchObject({ serverInfo: { name: "fake", version: "0" } });
  // the connection grew one method per listed tool (`callTool`, a reserved name, stays its own)
  expect(["echo", "add"].map((name) => typeof (conn as any)[name])).toEqual([
    "function",
    "function",
  ]);
});

const mcpRows: Array<{
  call: (c: McpConnectionRpcTarget) => Promise<unknown>;
  becomes?: unknown;
  throws?: RegExp;
  sse?: boolean;
}> = [
  { call: (c) => c.callTool("echo", { text: "hi" }), becomes: { echoed: { text: "hi" } } },
  { call: (c) => (c as any).echo({ text: "dotted" }), becomes: { echoed: { text: "dotted" } } }, // a tool as a method
  { call: (c) => (c as any).add({ a: 2, b: 3 }), becomes: { sum: 5 } }, // structuredContent wins over text
  { call: (c) => c.callTool("plain"), becomes: "just text" }, // text that is not JSON stays text
  { call: (c) => c.callTool("boom"), throws: /MCP tool boom failed: it broke/ },
  { call: (c) => c.callTool("nope"), throws: /MCP tools\/call: unknown tool nope/ },
  {
    call: (c) => c.callTool("echo", { via: "sse" }),
    becomes: { echoed: { via: "sse" } },
    sse: true,
  },
  { call: (c) => c.listTools(), becomes: TOOLS },
];
for (const row of mcpRows)
  test(`connectToMcp: ${row.call.toString().slice(0, 50)} → ${row.throws || JSON.stringify(row.becomes)}`, async () => {
    const { itx } = mcpItx(referenceServer({ sse: row.sse }));
    const conn = await connectToMcp(itx, "https://mcp.example/rpc");
    if (row.throws) await expect(row.call(conn)).rejects.toThrow(row.throws);
    else expect(await row.call(conn)).toEqual(row.becomes);
  });

test("connectToMcp: a tool named like a reserved member does not shadow it: callTool stays callTool", async () => {
  const { itx } = mcpItx(referenceServer());
  const conn = await connectToMcp(itx, "https://mcp.example/rpc");
  expect(await conn.callTool("echo", { x: 1 })).toEqual({ echoed: { x: 1 } });
});

test("connectToMcp: listTools REFUSES a server tool of the wrong shape — network data is parsed, not cast", async () => {
  // An external MCP server is untrusted: a tool whose `name` is a number must not reach a typed
  // frontend as McpTool[]. The first tools/list (at connect) is clean; the second is off-spec.
  let listings = 0;
  const { itx } = mcpItx((request, body) => {
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (body.method === "initialize")
      return json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "fake", version: "0" },
          },
        },
        { headers: { "mcp-session-id": "s-1" } },
      );
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result =
      body.method === "tools/list" ? { tools: ++listings === 1 ? [] : [{ name: 42 }] } : {};
    return json({ jsonrpc: "2.0", id: body.id, result });
  });
  const conn = await connectToMcp(itx, "https://mcp.example/rpc");
  await expect(conn.listTools()).rejects.toThrow();
});

test("connectToMcp: a stale handshake deletes ITS OWN session and never clobbers the live replacement", async () => {
  // The hard race: handshake A parks, a close happens, handshake B completes and goes live, then A
  // resumes. A must delete only ITS OWN session (s-2) and never touch the live one (s-3) — each
  // handshake owns its session id, so A cannot clobber B into sending sessionless requests.
  let inits = 0;
  const deletes: string[] = [];
  let releaseA: (() => void) | undefined;
  const { itx } = mcpItx((request, body) => {
    if (request.method === "DELETE") {
      deletes.push(request.headers.get("mcp-session-id") ?? "?");
      return new Response(null, { status: 204 });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "initialize") {
      const n = ++inits;
      const answer = json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "f" },
          },
        },
        { headers: { "mcp-session-id": `s-${n}` } },
      );
      return n === 2 ? new Promise<Response>((r) => (releaseA = () => r(answer))) : answer; // A parks
    }
    if (body.method === "tools/list")
      return json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    // a tool call echoes the session id it carried, so the test can see which session B used
    return json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(request.headers.get("mcp-session-id")) }],
      },
    });
  });
  const conn = await connectToMcp(itx, "https://mcp.example/rpc"); // s-1
  await conn.close(); // DELETE s-1; generation 1
  const aCall = conn.callTool("x").then(
    () => "A ok",
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  ); // handshake A parks at initialize #2 (captures generation 1)
  await new Promise((r) => setTimeout(r, 10));
  await conn.close(); // generation 2; A's memo cleared
  const bResult = await conn.callTool("y"); // handshake B → s-3 goes live, then tools/call carries s-3
  releaseA?.(); // A resumes → stale (gen 1 ≠ 2) → deletes s-2, throws
  const aOutcome = await aCall;

  expect(bResult).toBe("s-3"); // B's call used its OWN live session — never clobbered by A
  expect(aOutcome).toMatch(/closed during its handshake/);
  expect(deletes).toEqual(expect.arrayContaining(["s-1", "s-2"]));
  expect(deletes).not.toContain("s-3"); // the live session was not deleted
});

test("connectToMcp: callTool PRESERVES non-text content — an image part keeps its data and mimeType", async () => {
  const itx = serverWith((body) =>
    body.method === "tools/list"
      ? { tools: [] }
      : { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] },
  );
  const conn = await connectToMcp(itx, "https://mcp.example/rpc");
  // No text/structuredContent → callTool returns the whole result; the image bytes must survive.
  expect(await conn.callTool("shot")).toEqual({
    content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
  });
});

test("connectToMcp: a failed tool discovery closes the client — the handshake's session is DELETEd, not leaked", async () => {
  const deletes: string[] = [];
  const { itx } = mcpItx((request, body) => {
    if (request.method === "DELETE") {
      deletes.push(request.headers.get("mcp-session-id") ?? "?");
      return new Response(null, { status: 204 });
    }
    if (body.method === "initialize")
      return json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "f" },
          },
        },
        { headers: { "mcp-session-id": "s-1" } },
      );
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    // discovery fails AFTER the handshake went live
    return json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "boom" } });
  });
  await expect(connectToMcp(itx, "https://mcp.example/rpc")).rejects.toThrow();
  expect(deletes).toContain("s-1"); // the live session was cleaned up, not orphaned
});

test("connectToMcp: close DELETEs the session once; a server without a session id gets no DELETE", async () => {
  const withSession = mcpItx(referenceServer());
  const conn = await connectToMcp(withSession.itx, "https://mcp.example/rpc");
  await conn.close();
  await conn.close();
  const deletes = withSession.requests.filter((r) => r.request.method === "DELETE");
  expect(deletes).toHaveLength(1);
  expect(deletes[0].request.headers.get("mcp-session-id")).toBe("s-1");
  const sessionless = mcpItx(plainServer());
  await (await connectToMcp(sessionless.itx, "https://mcp.example/rpc")).close();
  expect(sessionless.requests.some((r) => r.request.method === "DELETE")).toBe(false);
});

test("connectToMcp: a connection closed by a holder re-runs its handshake on the next request — a closed connection is never dead", async () => {
  const { itx, requests } = mcpItx(referenceServer());
  const conn = await connectToMcp(itx, "https://mcp.example/rpc");
  await conn.close();
  expect(await conn.callTool("echo", { x: 1 })).toEqual({ echoed: { x: 1 } });
  expect(requests.filter((r) => r.body?.method === "initialize")).toHaveLength(2);
});

test("connectToMcp: a tool named `then` never makes the connection THENABLE (an await would adopt it and call the tool, never settling): connect settles, no tools/call, and the tool stays reachable through callTool", async () => {
  const { itx, requests } = mcpItx(plainServer([{ name: "then" }, { name: "echo" }]));
  const conn = await connectToMcp(itx, "https://mcp.example/rpc");
  expect(requests.map((r) => r.body?.method)).not.toContain("tools/call");
  expect((conn as { then?: unknown }).then).toBeUndefined();
  expect(await conn.callTool("then")).toBe("answered");
});

test("connectToMcp: an SSE answer the server leaves OPEN still connects — read as it arrives and left at the matching id, never awaited to EOF", async () => {
  const plain = plainServer();
  const encoder = new TextEncoder();
  const { itx } = mcpItx(async (request, body) => {
    const answer = await plain(request, body);
    if (answer.status !== 200) return answer;
    const message = await answer.text();
    return new Response(
      new ReadableStream({
        start(controller) {
          // one `data:` event, then the stream stays OPEN
          controller.enqueue(encoder.encode(`event: message\ndata: ${message}\n\n`));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const conn = await connectToMcp(itx, "https://mcp.example/rpc");
  expect(conn.serverInfo()).toMatchObject({ serverInfo: { name: "plain" } });
});

test("connectToMcp: a non-2xx answer throws with the status and the body", async () => {
  const { itx } = mcpItx(() => new Response("nope", { status: 503 }));
  await expect(connectToMcp(itx, "https://mcp.example/rpc")).rejects.toThrow(
    /MCP initialize returned 503: nope/,
  );
});

// ── openapi ── the OpenAPI connection against a fake service behind a fake `itx.fetch`:
// how one input object becomes path, query, header and body, and where the base URL comes from.

const PETS_SPEC: OpenApiDocument = {
  openapi: "3.0.0",
  servers: [{ url: "https://api.example/v1" }],
  paths: {
    "/pets/{id}": {
      parameters: [{ name: "id", in: "path", required: true }],
      get: { operationId: "getPet", summary: "one pet" },
      delete: { operationId: "deletePet" },
    },
    "/pets": {
      get: {
        operationId: "listPets",
        parameters: [
          { name: "limit", in: "query", required: true },
          { name: "tag", in: "query" },
        ],
      },
      post: { operationId: "createPet", requestBody: { content: { "application/json": {} } } },
    },
    "/me": { get: { operationId: "me", parameters: [{ name: "x-user", in: "header" }] } },
    "/raw": { put: { operationId: "putRaw", requestBody: {} } },
    "/text": { get: { operationId: "getText" } },
    "/call": { get: { operationId: "call" } }, // reserved: reachable through call('call') only
    "/session": {
      get: {
        operationId: "whoami",
        parameters: [
          { name: "session", in: "cookie" },
          { name: "theme", in: "cookie" },
        ],
      },
    },
    "/then": { get: { operationId: "then" } }, // reserved too: a thenable connection would never settle
    "/items": {
      parameters: [{ name: "limit", in: "query", required: true }],
      // the operation OVERRIDES the path item's `limit` (same name, same location): optional here
      get: { operationId: "listItems", parameters: [{ name: "limit", in: "query" }] },
    },
  },
};

test("openapi: an internal $ref parameter is RESOLVED; an external / missing / malformed ref is dropped, never surfaced as { name: undefined }", async () => {
  const spec = {
    openapi: "3.0.0",
    servers: [{ url: "https://api.example/v1" }],
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          parameters: [
            { $ref: "#/components/parameters/Limit" }, // internal — RESOLVED against components below
            { $ref: "https://other.example/p.json#/Cursor" }, // external — dropped (this path fetches only the spec)
            { $ref: "#/components/parameters/Missing" }, // internal but absent — dropped
            { name: "tag", in: "query" },
          ],
        },
      },
    },
    components: {
      parameters: { Limit: { name: "limit", in: "query", required: true } },
    },
  } as unknown as OpenApiDocument;
  const { itx } = openApiItx();
  const conn = await connectToOpenApi(itx, spec);
  const [op] = conn.operations();
  expect(op).toMatchObject({
    parameters: [
      { name: "limit", in: "query", required: true }, // the internal $ref resolved
      { name: "tag", in: "query" },
    ],
  });
  expect(op.parameters.every((p) => p.name && p.in)).toBe(true);
});

const openApiRows: Array<{
  op: string;
  input?: Record<string, unknown>;
  method: string;
  url: string;
  body?: unknown;
  header?: [string, string];
  throws?: RegExp;
}> = [
  {
    op: "getPet",
    input: { id: "a/b" },
    method: "GET",
    url: "https://api.example/v1/pets/a%2Fb",
  },
  { op: "deletePet", input: { id: 7 }, method: "DELETE", url: "https://api.example/v1/pets/7" },
  {
    op: "listPets",
    input: { limit: 2, tag: "cat" },
    method: "GET",
    url: "https://api.example/v1/pets?limit=2&tag=cat",
  },
  {
    op: "listPets",
    input: { limit: 2 },
    method: "GET",
    url: "https://api.example/v1/pets?limit=2",
  },
  {
    op: "createPet",
    input: { name: "rex", age: 3 },
    method: "POST",
    url: "https://api.example/v1/pets",
    body: { name: "rex", age: 3 },
  },
  {
    op: "putRaw",
    input: { body: [1, 2] },
    method: "PUT",
    url: "https://api.example/v1/raw",
    body: [1, 2],
  }, // `{ body }` alone is the body verbatim
  {
    op: "me",
    input: { "x-user": "u1" },
    method: "GET",
    url: "https://api.example/v1/me",
    header: ["x-user", "u1"],
  },
  {
    op: "whoami",
    input: { session: "s 1" },
    method: "GET",
    url: "https://api.example/v1/session",
    header: ["cookie", "session=s%201"],
  }, // a cookie parameter rides the cookie header
  {
    op: "whoami",
    input: { session: "s 1", theme: "dark" },
    method: "GET",
    url: "https://api.example/v1/session",
    header: ["cookie", "session=s%201; theme=dark"],
  }, // two cookie parameters are ONE `; `-joined header (RFC 6265), never `, `-joined
  { op: "getPet", input: {}, method: "GET", url: "", throws: /getPet needs "id"/ },
  {
    op: "listPets",
    input: {},
    method: "GET",
    url: "",
    throws: /listPets needs query parameter "limit"/,
  },
  { op: "listItems", input: {}, method: "GET", url: "https://api.example/v1/items" }, // the operation's optional `limit` overrides the path item's required one
  {
    op: "getText",
    input: { junk: 1 },
    method: "GET",
    url: "",
    throws: /getText has no request body and got unknown input key "junk"/,
  },
  { op: "nope", method: "GET", url: "", throws: /no operation "nope"/ },
];
for (const row of openApiRows)
  test(`connectToOpenApi: ${row.op}(${JSON.stringify(row.input || {})}) → ${row.throws || `${row.method} ${row.url}`}`, async () => {
    const { itx, requests } = openApiItx();
    const conn = await connectToOpenApi(itx, PETS_SPEC, { headers: { authorization: "Bearer t" } });
    if (row.throws) {
      await expect(conn.call(row.op, row.input)).rejects.toThrow(row.throws);
      return;
    }
    expect(await conn.call(row.op, row.input)).toEqual({ ok: true });
    const [request] = requests;
    expect(request).toMatchObject({ method: row.method, url: row.url });
    expect(request.headers.get("authorization")).toBe("Bearer t");
    if (row.body !== undefined) {
      expect(JSON.parse(await request.text())).toEqual(row.body);
      expect(request.headers.get("content-type")).toBe("application/json");
    } else expect(request.body).toBeNull();
    if (row.header) expect(request.headers.get(row.header[0])).toBe(row.header[1]);
  });

test("connectToOpenApi: operations become methods; a reserved operationId (`call`, and `then` — a thenable connection would never settle) stays reachable through call()", async () => {
  const { itx, requests } = openApiItx();
  const conn = await connectToOpenApi(itx, PETS_SPEC);
  expect(conn.operations().map((o) => o.operationId)).toEqual([
    "getPet",
    "deletePet",
    "listPets",
    "createPet",
    "me",
    "putRaw",
    "getText",
    "call",
    "whoami",
    "then",
    "listItems",
  ]);
  expect((conn as { then?: unknown }).then).toBeUndefined();
  expect(await (conn as any).getPet({ id: 1 })).toEqual({ ok: true });
  expect(await conn.call("call")).toEqual({ ok: true });
  expect(await conn.call("then")).toEqual({ ok: true });
  expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
    "/v1/pets/1",
    "/v1/call",
    "/v1/then",
  ]);
});

test("connectToOpenApi: a text answer is text; a non-2xx answer throws with the status and a snippet", async () => {
  const { itx } = openApiItx((request) =>
    request.url.endsWith("/text")
      ? new Response("plain", { headers: { "content-type": "text/plain" } })
      : new Response("gone", { status: 410 }),
  );
  const conn = await connectToOpenApi(itx, PETS_SPEC);
  expect(await conn.call("getText")).toBe("plain");
  await expect(conn.call("getPet", { id: 1 })).rejects.toThrow(
    /GET \/v1\/pets\/1 \(getPet\) returned 410: gone/,
  );
});

test("connectToOpenApi: from a URL: the document is fetched (auth headers only on the API's host), and a document without servers is addressed under the spec URL, QUERY KEPT", async () => {
  const specUrl = "https://api--prj-x.worker.example/v2/openapi.json?rev=3";
  const { itx, requests } = openApiItx((request) =>
    request.url === specUrl
      ? json({ ...PETS_SPEC, servers: [] })
      : json({ pet: new URL(request.url).pathname }),
  );
  const conn = await connectToOpenApi(itx, specUrl, {
    headers: { authorization: "Bearer t" },
  });
  expect(requests[0].headers.get("authorization")).toBe("Bearer t");
  expect(await conn.call("getPet", { id: 5 })).toEqual({ pet: "/v2/pets/5" });
  expect(requests[1]).toMatchObject({ url: "https://api--prj-x.worker.example/v2/pets/5?rev=3" });
  // the spec on another host than the API (baseUrl names the API): the auth header stays home
  const other = openApiItx((request) =>
    request.url.includes("spec.example") ? json(PETS_SPEC) : json({}),
  );
  const conn2 = await connectToOpenApi(other.itx, "https://spec.example/openapi.json", {
    baseUrl: "https://api.example/v1",
    headers: { authorization: "Bearer t" },
  });
  expect(other.requests[0].headers.get("authorization")).toBeNull();
  await conn2.call("getPet", { id: 1 });
  expect(other.requests[1].headers.get("authorization")).toBe("Bearer t");
});

test("connectToOpenApi: from a URL: a RELATIVE servers[0].url resolves against the spec URL, QUERY KEPT", async () => {
  const specUrl = "https://api--prj-x.worker.example/v2/openapi.json?rev=3";
  const { itx, requests } = openApiItx((request) =>
    request.url === specUrl
      ? json({ ...PETS_SPEC, servers: [{ url: "api" }] })
      : json({ ok: true }),
  );
  const conn = await connectToOpenApi(itx, specUrl);
  await conn.call("getPet", { id: 5 });
  expect(requests[1]).toMatchObject({
    url: "https://api--prj-x.worker.example/v2/api/pets/5?rev=3",
  });
});

test("connectToOpenApi: an INLINE document whose servers[0].url is relative is refused at connect with the baseUrl hint — never a raw TypeError", async () => {
  await expect(
    connectToOpenApi(openApiItx().itx, { ...PETS_SPEC, servers: [{ url: "/v1" }] }),
  ).rejects.toThrow(/needs \{ baseUrl \}/);
});

test("connectToOpenApi: baseUrl overrides the document's server", async () => {
  const { itx, requests } = openApiItx();
  const conn = await connectToOpenApi(itx, PETS_SPEC, { baseUrl: "https://staging.example/api/" });
  await conn.call("getPet", { id: 1 });
  expect(requests[0]).toMatchObject({ url: "https://staging.example/api/pets/1" });
});

test("connectToOpenApi: not an OpenAPI document → refused at connect", async () => {
  await expect(connectToOpenApi(openApiItx().itx, { nope: true } as any)).rejects.toThrow(
    /not an OpenAPI 3 document/,
  );
});

// ── the library boundary ── THE LIBRARY RULE, pinned: a library module takes `itx` and nothing else,
// so at runtime it may import only npm packages a userspace worker could bundle too (capnweb,
// cloudflare:workers) and the one platform primitive that is pure data or a handle
// (context/expression.ts — the codec, for an expression carried as data, and the pipelinable
// handle), and the library's own files. Type-only imports are free (they erase). Anything else — the
// stream, the DO, the rest of context/ — would make the library un-movable to userspace, which is
// the whole point of the tier.
const ALLOWED_RUNTIME_IMPORTS = new Set([
  "capnweb",
  "cloudflare:workers",
  "zod", // an npm package a userspace worker could bundle too — used to PARSE untrusted MCP responses
  "iterate/expression", // the codec — the package's, as a userspace worker would import it
  "iterate/lib", // the package's pure helpers (error codes, resolveContextPath) — in the SDK bundle every userspace worker gets
  // The entities' CONTRACTS — pure zod over `defineProcessorContract` (the SDK's), no stream, DO or
  // context runtime: the vocabulary a handle's typed `append` validates against, which a userspace
  // worker would import from the SDK just the same.
  "./repo/contract.ts",
  "./workspace/contract.ts",
  // The SDK's `withItx` as module TEXT (scripts/build.ts): data a script's isolate imports beside the
  // script (`runScriptModule`), never code the library runs itself.
  "./generated/with-itx-module.js",
]);

test("the library boundary: library.ts and library/*.ts import only npm packages, the codec, each other, and types", () => {
  const sourceDirectory = new URL("./", import.meta.url);
  const libraryDirectory = new URL("./library/", import.meta.url);
  const libraryFiles = [
    new URL("./library.ts", import.meta.url),
    ...readdirSync(libraryDirectory.pathname)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => new URL(name, libraryDirectory)),
  ];
  const libraryPaths = new Set(libraryFiles.map((file) => file.pathname));
  const offenders: string[] = [];
  for (const file of libraryFiles) {
    const source = readFileSync(file.pathname, "utf8");
    for (const match of source.matchAll(
      /^import\s+(type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm,
    )) {
      const [, typeOnly, specifier] = match;
      if (typeOnly || ALLOWED_RUNTIME_IMPORTS.has(specifier)) continue;
      if (specifier.startsWith(".") && libraryPaths.has(new URL(specifier, file).pathname))
        continue;
      offenders.push(`${file.pathname.slice(sourceDirectory.pathname.length)}: ${specifier}`);
    }
  }
  expect(offenders).toEqual([]);
});

class RemotesApi extends RpcTarget {
  hello() {
    return "hi";
  }
}

const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
  });

/** The three remotes behind one `itx.fetch`, by host: an MCP server (`mcp.example` — a session id on
 *  initialize, DELETE on close), an OpenAPI document (`api.example/openapi.json`) and a capnweb batch
 *  endpoint (`rpc.example`). `seen` is every request: the JSON-RPC method, `GET <path>`, `DELETE`. */
function remotes(): { itx: LibraryItx; seen: string[] } {
  const seen: string[] = [];
  const itx = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.host === "rpc.example") return newHttpBatchRpcResponse(request, new RemotesApi());
      if (url.host === "api.example") {
        seen.push(`GET ${url.pathname}`);
        return json(url.pathname.endsWith("openapi.json") ? REMOTES_SPEC : { ok: true });
      }
      if (request.method === "DELETE") {
        seen.push("DELETE");
        return new Response(null, { status: 204 });
      }
      const body = JSON.parse(await request.text()) as { id?: number; method: string };
      seen.push(body.method);
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "f" } }
          : body.method === "tools/list"
            ? { tools: [{ name: "echo" }] }
            : { content: [{ type: "text", text: '"ok"' }] };
      return json(
        { jsonrpc: "2.0", id: body.id, result },
        body.method === "initialize" ? { headers: { "mcp-session-id": "s-1" } } : {},
      );
    },
  } as unknown as LibraryItx;
  return { itx, seen };
}

const initializes = (seen: string[]) => seen.filter((m) => m === "initialize").length;

/** A fake itx: `append` lands at offsets from 10, `waitForEvent` answers `settlements` in order
 *  (an event, or "timeout" = a WAIT_TIMEOUT rejection). */
function host(settlements: (StreamEvent | "timeout")[] = []): {
  itx: LibraryItx;
  loaded: unknown[];
  appended: StreamEventInput[];
  waits: WaitForEventFilter[];
  runs: () => number;
} {
  const loaded: unknown[] = [];
  const appended: StreamEventInput[] = [];
  const waits: WaitForEventFilter[] = [];
  let ran = 0;
  // The host is minted at the FIXED POINT (`itx.builtins.workers.get`), and the request and the wait
  // are spelled there too (`itx.builtins.append` / `waitForEvent`): the runner's plumbing is the
  // kernel's act, never subject to the context's table (a jail's bare null).
  const workers = {
    get: (spec: unknown) => {
      loaded.push(spec);
      return {
        run: async (...args: unknown[]) => {
          ran += 1;
          return { calledWith: args.length }; // run() is called with NO arguments
        },
      };
    },
  };
  const append = async (...events: StreamEventInput[]) => {
    appended.push(...events);
    const firstOffset = 10 + appended.length - events.length;
    return events.map((event, i) => ({
      ...event,
      offset: firstOffset + i,
      createdAt: "t",
      path: "/",
    }));
  };
  const waitForEvent = async (filter: WaitForEventFilter) => {
    waits.push(filter);
    const next = settlements.shift();
    if (next === "timeout") throw codedError("WAIT_TIMEOUT", "no event");
    if (!next) throw new Error("the test scripted no more settlements");
    return next;
  };
  const itx = {
    fetch: async () => new Response(null),
    builtins: { workers, append, waitForEvent },
  } as unknown as LibraryItx;
  return { itx, loaded, appended, waits, runs: () => ran };
}

const settledAt = (offset: number, requestOffset: number, settlement: unknown): StreamEvent => ({
  type: "events.iterate.com/context/run-settled",
  payload: { requestOffset, settlement },
  offset,
  createdAt: "t",
  path: "/",
});

/** THE MODULE, RUN: the text the loader gets, imported here as a module with its imports stood in
 *  for (`WorkerEntrypoint`, which only hands `env` over; `./with-itx.js`, the real bundled module), so
 *  its `run()` executes exactly as written — under fake timers. `disposals()` counts the script's
 *  scope being released; `itx` stands in for the scope. */
async function loadedRun(
  script: string,
  itx: object = {},
): Promise<{ run: () => Promise<unknown>; disposals: () => number }> {
  let disposals = 0;
  const module = runScriptModule(script);
  const withItxUrl = `data:text/javascript,${encodeURIComponent(module["with-itx.js"])}`;
  const standIn = module["cap.js"]
    .replace(
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      "class WorkerEntrypoint { constructor(ctx, env) { this.env = env; } }",
    )
    .replace('"./with-itx.js"', JSON.stringify(withItxUrl));
  const { default: Entrypoint } = await import(
    /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(standIn)}`
  );
  const disposeScope = (itx as Partial<Disposable>)[Symbol.dispose];
  const scope = Object.assign(itx, {
    [Symbol.dispose]: () => {
      disposals += 1;
      disposeScope?.();
    },
  });
  const entrypoint = new Entrypoint({}, { ITX: { get: () => scope } });
  return { run: () => entrypoint.run(), disposals: () => disposals };
}

/** A value carrying a disposer, as a Workers-RPC result or stub does; `releases()` counts calls. */
function releasable<T extends object>(value: T): { value: T; releases: () => number } {
  let releases = 0;
  return {
    value: Object.assign(value, { [Symbol.dispose]: () => (releases += 1) }),
    releases: () => releases,
  };
}

class Counter extends RpcTarget {
  #n = 0;
  inc(by = 1) {
    this.#n += by;
    return this.#n;
  }
}

class CapnwebApi extends RpcTarget {
  hello(name: string) {
    return `hello ${name}`;
  }
  counter() {
    return new Counter();
  }
  boom() {
    throw new Error("kaboom");
  }
}

function capnwebItx() {
  const requests: Request[] = [];
  const itx = {
    fetch: async (request: Request) => {
      requests.push(request);
      return newHttpBatchRpcResponse(request, new CapnwebApi());
    },
  } as unknown as LibraryItx;
  return { itx, requests };
}

/** A fake `itx` whose fetch records requests and answers with `handler`. */
function mcpItx(handler: Handler): {
  itx: LibraryItx;
  requests: Array<{ request: Request; body: any }>;
} {
  const requests: Array<{ request: Request; body: any }> = [];
  const itx = {
    fetch: async (request: Request) => {
      const text = await request.clone().text();
      const body = text ? JSON.parse(text) : undefined;
      requests.push({ request, body });
      return handler(request, body);
    },
  } as unknown as LibraryItx;
  return { itx, requests };
}

/** The reference fake server: hands out a session id on initialize and insists on it afterwards. */
function referenceServer(options: { sse?: boolean } = {}): Handler {
  return (request, body) => {
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (body.method === "initialize")
      return json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "0" },
          },
        },
        { headers: { "mcp-session-id": "s-1" } },
      );
    if (request.headers.get("mcp-session-id") !== "s-1")
      return new Response("no session", { status: 400 });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    let result: unknown;
    if (body.method === "tools/list") result = { tools: TOOLS };
    else if (body.method === "tools/call") {
      const { name, arguments: args } = body.params;
      if (name === "echo")
        result = { content: [{ type: "text", text: JSON.stringify({ echoed: args }) }] };
      else if (name === "add")
        result = {
          content: [{ type: "text", text: "ignored" }],
          structuredContent: { sum: args.a + args.b },
        };
      else if (name === "plain") result = { content: [{ type: "text", text: "just text" }] };
      else if (name === "boom")
        result = { content: [{ type: "text", text: "it broke" }], isError: true };
      else
        return json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32602, message: `unknown tool ${name}` },
        });
    }
    const message = { jsonrpc: "2.0", id: body.id, result };
    return options.sse
      ? new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      : json(message);
  };
}

/** A session-less server (no `mcp-session-id`, so nothing to DELETE): initialize, then `tools`, then
 *  every tools/call answers `answer` as text. */
function plainServer(tools: { name: string }[] = [], answer = "answered"): Handler {
  return (_request, body) => {
    if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result =
      body?.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "plain" } }
        : body?.method === "tools/list"
          ? { tools }
          : { content: [{ type: "text", text: answer }] };
    return json({ jsonrpc: "2.0", id: body?.id, result });
  };
}

/** A minimal live server: session s-1, and `handler` for tools/list + tools/call. */
const serverWith = (handler: (body: any) => unknown): LibraryItx =>
  mcpItx((request, body) => {
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (body.method === "initialize")
      return json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "f" },
          },
        },
        { headers: { "mcp-session-id": "s-1" } },
      );
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return json({ jsonrpc: "2.0", id: body.id, result: handler(body) });
  }).itx;

function openApiItx(answer: (request: Request) => Response = () => json({ ok: true })) {
  const requests: Request[] = [];
  const itx = {
    fetch: async (request: Request) => {
      requests.push(request);
      return answer(request);
    },
  } as unknown as LibraryItx;
  return { itx, requests };
}
