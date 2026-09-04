// src/review-bugs-round2.test.ts — the PURE-LOGIC proofs of the 2026-09-04 round-2 bug hunt
// (docs/reviews/2026-09-04-round2-bugs-do-side.md and -edge-side.md): the resolver, the codec, the
// core reduce, the relay and the library connectors over fakes, no workerd. The proofs that need real
// storage or the DO's sockets are in __workers-tests__/review-bugs-round2.test.ts; the ones that need
// the whole worker are in e2e/review-bugs-round2.e2e.test.ts. Every test is titled `<report>#<n>`;
// `test.fails` is the house convention for a known-red proof (the lane stays green while the bug is
// open), and flipping it back to `test` is how a fix is proved. Each was run RED first.

import { RpcTarget, newHttpBatchRpcResponse } from "capnweb";
import { describe, expect, test } from "vitest";
import {
  parse,
  parseItxExpressionPrefix,
  print,
  type ItxExpression,
} from "./context/expression.ts";
import { InvokeHandle } from "./context/invoke-handle.ts";
import {
  ItxExpressionResolver,
  rewriteRuleConfiguredEvent,
  rowsNamingRpcStub,
  type ItxExpressionRewriteRule,
} from "./context/itx-expression-rewriting.ts";
import { buildLibrary, type LibraryItx } from "./library/index.ts";
import { connectToMcp } from "./library/mcp.ts";
import { connectToOpenApi, type OpenApiDocument } from "./library/openapi.ts";
import { CoreStreamProcessor, type CoreState } from "./stream/core-processor.ts";
import type { StreamEvent, StreamEventInput } from "./stream/events.ts";
import { subscriptionConfiguredEvent } from "./stream/subscriptions.ts";

const ROOTS = new Set(["kv", "whoami", "rpcStubs", "ai", "facets", "fetch"]);
const rule = (match: string, target: string | null): ItxExpressionRewriteRule => ({
  match: parseItxExpressionPrefix(match),
  target: target === null ? null : parse(target, { holes: true }),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const raced = <T>(p: Promise<T>, ms: number): Promise<T | "TIMED OUT"> =>
  Promise.race([p, sleep(ms).then(() => "TIMED OUT" as const)]);

// ── the core reduce, driven by hand ──

/** The core reduce over a log of the events given, from the initial state; `at` is the offset. */
function reduced(events: StreamEventInput[]): CoreState {
  const processor = new CoreStreamProcessor();
  let state = processor.contract.initialState();
  events.forEach((input, i) => {
    const event = {
      ...input,
      offset: i + 1,
      createdAt: new Date(0).toISOString(),
      path: "/",
    } as StreamEvent;
    state = processor.reduce({ event, state } as never) ?? state;
  });
  return state;
}

// ───────────────────────────── DO-side findings ─────────────────────────────

// do-side#1 — BUG (fixed): `#unsetWhatNamesRpcStub` resolved each row against the LIVE table while its
// own synchronous appends changed it, so a user's alias to a shadowed root (`itx.llm ⇒ itx.ai` while
// `itx.ai` is a lent fake) was deleted as collateral when the fake died — or kept — depending on which
// row had been configured first. FIX: the removal set is decided against ONE frozen table, counting
// direct namers and rows that STILL resolve to the key without them; order-independent by construction.
describe("do-side#1: what names a dead stub is decided against a frozen table, whatever the configuration order", () => {
  const alias = rule("itx.llm", "itx.ai");
  const fake = rule("itx.ai", "itx.builtins.rpcStubs.get('itx.ai')");
  const ownRegistry = rule("itx.reg", "itx.builtins.rpcStubs");
  const throughOwnRegistry = rule("itx.cam", "itx.reg.get('itx.ai')");
  for (const [label, rules] of [
    ["alias first", [alias, fake, ownRegistry, throughOwnRegistry]],
    ["stub first", [fake, alias, ownRegistry, throughOwnRegistry]],
  ] as const) {
    test(`${label}: the fake's own row and a row naming the key through the user's own registry go; the alias stays`, () => {
      const { ruleMatches, subscriptionNames } = rowsNamingRpcStub({
        rpcStubKey: "itx.ai",
        rules,
        subscriptionTargets: {
          viaShortSpelling: parse("itx.rpcStubs.get('itx.ai')"),
          viaAlias: parse("itx.llm.notify"),
        },
        isBuiltInRoot: (root) => ROOTS.has(root),
      });
      expect(ruleMatches.map((m) => print(m)).sort()).toEqual(["itx.ai", "itx.cam"]);
      // the short spelling names the registry through the platform row and goes; the alias-spelled
      // subscription resolves to the platform `ai` beneath once the fake is gone, and stays
      expect(subscriptionNames).toEqual(["viaShortSpelling"]);
    });
  }
});

// do-side#3 — BUG (fixed): an MCP tool or an OpenAPI operation named `then` made the connection
// THENABLE — an async function returning it adopted it as a promise, called the tool, and never
// settled. FIX: `then` is a reserved member in both connectors (reachable through callTool / call).
describe("do-side#3: a tool or an operation named `then` does not make the connection thenable", () => {
  const json = (value: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(value), {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
    });
  test("MCP: connect settles and sends no tools/call", async () => {
    const seen: string[] = [];
    const itx = {
      fetch: async (request: Request) => {
        const body = JSON.parse(await request.text()) as { id?: number; method: string };
        seen.push(body.method);
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        const result =
          body.method === "initialize"
            ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "f" } }
            : { tools: [{ name: "then" }, { name: "echo" }] };
        return json({ jsonrpc: "2.0", id: body.id, result });
      },
    } as unknown as LibraryItx;
    const connection = await raced(connectToMcp(itx, "https://mcp.example/"), 500);
    expect(connection).not.toBe("TIMED OUT");
    expect(seen).not.toContain("tools/call");
  });
  test("OpenAPI: connect settles and sends no GET /then", async () => {
    const seen: string[] = [];
    const spec: OpenApiDocument = {
      openapi: "3.0.0",
      servers: [{ url: "https://api.example/v1" }],
      paths: { "/then": { get: { operationId: "then" } } },
    };
    const itx = {
      fetch: async (request: Request) => {
        seen.push(`${request.method} ${new URL(request.url).pathname}`);
        return json({ ok: true });
      },
    } as unknown as LibraryItx;
    const connection = await raced(connectToOpenApi(itx, spec), 500);
    expect(connection).not.toBe("TIMED OUT");
    expect(seen).toEqual([]);
  });
});

// do-side#2 — BUG (fixed): a connector reached THROUGH a rewrite rule (`provide('itx.tools',
// "itx.connectToMcp(url)")`) opened a session per call that no intermediate holder ever disposed — for
// capnweb an open WebSocket per call, pinning the context. FIX: the library memoizes live connections
// per (verb, url, options) for the context's life; `releaseConnections()` (the idle quiesce) closes
// them; a closed connection re-runs its handshake on the next use.
describe("do-side#2: connections are memoized per context, released at the quiesce, reopened on use", () => {
  const json = (value: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(value), {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
    });
  const mcpServer = (): { itx: LibraryItx; seen: string[] } => {
    const seen: string[] = [];
    const itx = {
      fetch: async (request: Request) => {
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
  };
  test("two connects with the same arguments are ONE handshake; two tool calls through them are two tools/call", async () => {
    const { itx, seen } = mcpServer();
    const { roots } = buildLibrary(itx);
    const a = await roots.connectToMcp("https://mcp.example/", { headers: { authorization: "t" } });
    const b = await roots.connectToMcp("https://mcp.example/", { headers: { authorization: "t" } });
    expect(b).toBe(a);
    await a.callTool("echo", {});
    await b.callTool("echo", {});
    expect(seen.filter((m) => m === "initialize")).toHaveLength(1);
    expect(seen.filter((m) => m === "tools/call")).toHaveLength(2);
  });
  test("releaseConnections DELETEs the session; the next connect is a fresh handshake", async () => {
    const { itx, seen } = mcpServer();
    const { roots, releaseConnections } = buildLibrary(itx);
    const a = await roots.connectToMcp("https://mcp.example/");
    releaseConnections();
    await sleep(10);
    expect(seen).toContain("DELETE");
    const b = await roots.connectToMcp("https://mcp.example/");
    expect(b).not.toBe(a);
    expect(seen.filter((m) => m === "initialize")).toHaveLength(2);
  });
  test("a connection closed by a holder re-runs its handshake on the next request", async () => {
    const { itx, seen } = mcpServer();
    const a = await connectToMcp(itx, "https://mcp.example/");
    await a.close();
    expect(await a.callTool("echo", {})).toBe("ok");
    expect(seen.filter((m) => m === "initialize")).toHaveLength(2);
  });
  test("a connect that FAILS is not memoized — the next call retries", async () => {
    let attempts = 0;
    const itx = {
      fetch: async () => {
        attempts += 1;
        return new Response("down", { status: 503 });
      },
    } as unknown as LibraryItx;
    const { roots } = buildLibrary(itx);
    await expect(roots.connectToMcp("https://mcp.example/")).rejects.toThrow(/503/);
    await expect(roots.connectToMcp("https://mcp.example/")).rejects.toThrow(/503/);
    expect(attempts).toBe(2);
  });
  test("the memo is keyed by the options too, and two spellings of one options object are one key", async () => {
    const { itx, seen } = mcpServer();
    const { roots } = buildLibrary(itx);
    const a = await roots.connectToMcp("https://mcp.example/", { headers: { a: "1", b: "2" } });
    const b = await roots.connectToMcp("https://mcp.example/", { headers: { b: "2", a: "1" } });
    const c = await roots.connectToMcp("https://mcp.example/", { headers: { a: "other" } });
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(seen.filter((m) => m === "initialize")).toHaveLength(2);
  });
  test("capnweb over the batch transport: the same connection object comes back", async () => {
    class Api extends RpcTarget {
      hello() {
        return "hi";
      }
    }
    const itx = {
      fetch: async (request: Request) => newHttpBatchRpcResponse(request, new Api()),
    } as unknown as LibraryItx;
    const { roots } = buildLibrary(itx);
    const a = await roots.connectToCapnweb("https://api.example/rpc", { transport: "batch" });
    const b = await roots.connectToCapnweb("https://api.example/rpc", { transport: "batch" });
    expect(b).toBe(a);
    expect(await (a as any).hello()).toBe("hi");
  });
});

// do-side#4 — BUG (fixed): `hostedFacet` was decided ONCE, at configure time, but the delivery loop
// re-resolves the target at every push — a rule landing after the row, or re-pointed later, hosted a
// facet the row did not own (orphaned on disable), or the wrong facet was deleted. FIX: every rule
// commit re-derives the marker of every non-builtins-rooted row through the new table.
describe("do-side#4: a row's hostedFacet marker follows the rules", () => {
  const facetF = "itx.builtins.facets.get('f',{source:{'cap.js':'x'},className:'F'})";
  const facetG = "itx.builtins.facets.get('g',{source:{'cap.js':'y'},className:'G'})";
  test("a rule configured AFTER the row makes the row host that facet", () => {
    const state = reduced([
      subscriptionConfiguredEvent({ name: "s", target: "itx.proc.processEventBatch" }),
      rewriteRuleConfiguredEvent("itx.proc", facetF),
    ]);
    expect(state.subscriptions.s.hostedFacet).toEqual({ name: "f", className: "F" });
  });
  test("a rule RE-POINTED after the row moves the marker; removing the rule drops it", () => {
    const before = reduced([
      rewriteRuleConfiguredEvent("itx.proc", facetF),
      subscriptionConfiguredEvent({ name: "s", target: "itx.proc.processEventBatch" }),
    ]);
    expect(before.subscriptions.s.hostedFacet?.name).toBe("f");
    const repointed = reduced([
      rewriteRuleConfiguredEvent("itx.proc", facetF),
      subscriptionConfiguredEvent({ name: "s", target: "itx.proc.processEventBatch" }),
      rewriteRuleConfiguredEvent("itx.proc", facetG),
    ]);
    expect(repointed.subscriptions.s.hostedFacet?.name).toBe("g");
    const removed = reduced([
      rewriteRuleConfiguredEvent("itx.proc", facetF),
      subscriptionConfiguredEvent({ name: "s", target: "itx.proc.processEventBatch" }),
      rewriteRuleConfiguredEvent("itx.proc", null),
      rewriteRuleConfiguredEvent("itx.other", "itx.builtins.kv"), // any later table change
    ]);
    // `itx.proc` is masked (unresolvable) at the first change — the marker is kept, conservatively —
    // and a rule commit that resolves it elsewhere drops it
    expect(removed.subscriptions.s.hostedFacet?.name).toBe("f");
    const elsewhere = reduced([
      rewriteRuleConfiguredEvent("itx.proc", facetF),
      subscriptionConfiguredEvent({ name: "s", target: "itx.proc.processEventBatch" }),
      rewriteRuleConfiguredEvent("itx.proc", "itx.builtins.kv"),
    ]);
    expect(elsewhere.subscriptions.s.hostedFacet).toBeUndefined();
  });
  test("a row whose OWN target carried the spec (elided, M1) keeps its marker across rule commits", () => {
    const state = reduced([
      subscriptionConfiguredEvent({
        name: "s",
        target: `${facetF.replace("itx.builtins.", "itx.")}.processEventBatch`,
      }),
      rewriteRuleConfiguredEvent("itx.unrelated", "itx.builtins.kv"),
    ]);
    expect(state.subscriptions.s.hostedFacet).toEqual({ name: "f", className: "F" });
    expect(print(state.subscriptions.s.target)).toBe("itx.facets.get('f').processEventBatch");
  });
  test("a platform-written (builtins-rooted, elided) row is untouched by rule commits", () => {
    const state = reduced([
      subscriptionConfiguredEvent({ name: "s", target: `${facetF}.processEventBatch` }),
      rewriteRuleConfiguredEvent("itx.facets", "itx.builtins.kv"),
    ]);
    expect(state.subscriptions.s.hostedFacet).toEqual({ name: "f", className: "F" });
  });
});

// do-side#7 (the relay's dup leak) is proved in __workers-tests__/review-bugs-round2.test.ts: the
// relay module imports cloudflare:workers, which the node lane has no shim for.

// do-side#8 — BUG (fixed): OpenAPI — a relative `servers[0].url` on an INLINE document threw a raw
// `TypeError: Invalid URL`; a `cookie` parameter was refused as an unknown input key. FIX: the
// "needs { baseUrl }" refusal, and cookie parameters ride the cookie header.
describe("do-side#8: OpenAPI edges", () => {
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  test("a relative server url on an inline document is refused with the baseUrl hint, not a TypeError", async () => {
    const spec: OpenApiDocument = {
      openapi: "3.0.0",
      servers: [{ url: "/v1" }],
      paths: { "/me": { get: { operationId: "me" } } },
    };
    const itx = { fetch: async () => json({}) } as unknown as LibraryItx;
    await expect(connectToOpenApi(itx, spec)).rejects.toThrow(/needs \{ baseUrl \}/);
  });
  test("a cookie parameter becomes a cookie header and is not an unknown input key", async () => {
    const spec: OpenApiDocument = {
      openapi: "3.0.0",
      servers: [{ url: "https://api.example/v1" }],
      paths: {
        "/me": { get: { operationId: "me", parameters: [{ name: "session", in: "cookie" }] } },
      },
    };
    const requests: Request[] = [];
    const itx = {
      fetch: async (request: Request) => {
        requests.push(request);
        return json({ ok: true });
      },
    } as unknown as LibraryItx;
    const connection = await connectToOpenApi(itx, spec);
    expect(await connection.call("me", { session: "s 1" })).toEqual({ ok: true });
    expect(requests[0].headers.get("cookie")).toBe("session=s%201");
  });
});

// ───────────────────────────── edge-side findings ─────────────────────────────

// edge#1 — BUG (fixed): `invoke(call, ...args)` resolved the call WITHOUT its live args, then applied
// them to the result: `invoke("itx.fable", inputs)` ran the template with NO inputs (rule 7's drop
// branch — a side effect) and threw NOT_A_METHOD; a pinned row (`itx.ai.run('gpt-5')`) and a pinned
// MASK were walked around. FIX: live args are folded into a name-final call BEFORE resolving.
describe("edge#1: invoke(call, ...args) resolves the call WITH its live args", () => {
  const calls: unknown[][] = [];
  const builtIns = {
    ai: {
      run: (...args: unknown[]) => {
        calls.push(args);
        return "ran";
      },
    },
    kv: { get: (k: string) => `kv:${k}` },
    rpcStubs: { get: () => new InvokeHandle((steps) => ["stubbed", steps]) },
  };
  const rules = () => [
    rule("itx.fable", "itx.builtins.ai.run('@cf/x', @)"),
    rule("itx.ai.run('gpt-5')", "itx.builtins.rpcStubs.get('s')"),
    rule("itx.kv.get('secret')", null),
  ];
  const resolver = new ItxExpressionResolver({ builtIns, rewriteRules: rules });
  test("a template fills from the live args, exactly as the dotted call would", async () => {
    calls.length = 0;
    expect(await resolver.invoke("itx.fable", [{ prompt: "hi" }])).toBe("ran");
    expect(calls).toEqual([["@cf/x", { prompt: "hi" }]]);
  });
  test("a pinned row matches the live args", async () => {
    expect(await resolver.invoke("itx.ai.run", ["gpt-5", { q: 1 }])).toEqual([
      "stubbed",
      [["", { q: 1 }]],
    ]);
  });
  test("a pinned mask refuses the live args (default-deny)", async () => {
    await expect(resolver.invoke("itx.kv.get", ["secret"])).rejects.toMatchObject({
      code: "NO_ITX_EXPRESSION_MATCH",
    });
    expect(await resolver.invoke("itx.kv.get", ["public"])).toBe("kv:public");
  });
  test("a call-final expression keeps the old shape: the args apply to the value it denotes", async () => {
    const handle = await resolver.invoke("itx.builtins.rpcStubs.get('s')", [1, 2]);
    expect(handle).toEqual(["stubbed", [["", 1, 2]]]);
  });
});

// edge#3 — BUG (fixed): `connectToMcp` read a `text/event-stream` answer with `response.text()`,
// waiting for an EOF a conformant server may never send (it SHOULD close the stream, not MUST) —
// a hang with no timeout anywhere. FIX: the stream is read as it arrives and left at the matching id.
test("edge#3: an SSE answer the server keeps open still connects — read as it arrives", async () => {
  const encoder = new TextEncoder();
  const itx = {
    fetch: async (request: Request) => {
      const body = JSON.parse(await request.text()) as { id?: number; method: string };
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "f" } }
          : { tools: [] };
      const message = { jsonrpc: "2.0", id: body.id, result };
      // one `data:` event, then the stream stays OPEN
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  } as unknown as LibraryItx;
  const connection = await raced(connectToMcp(itx, "https://mcp.example/"), 2000);
  expect(connection).not.toBe("TIMED OUT");
});

// edge#4 — BUG (fixed): OpenAPI behind the fetch lane — a RELATIVE `servers[0].url` resolved against
// the lane's spec URL dropped `?context=&itx=`, so every operation hit the worker's banner and
// returned it as a 200 answer. FIX: a relative server url keeps the spec URL's query.
test("edge#4: a relative servers[0].url resolved against a fetch-lane spec URL keeps ?context=&itx=", async () => {
  const seen: string[] = [];
  const spec: OpenApiDocument = {
    openapi: "3.0.0",
    servers: [{ url: "api" }],
    paths: { "/pets": { get: { operationId: "listPets" } } },
  };
  const itx = {
    fetch: async (request: Request) => {
      seen.push(`${request.method} ${request.url}`);
      return new Response(JSON.stringify(seen.length === 1 ? spec : []), {
        headers: { "content-type": "application/json" },
      });
    },
  } as unknown as LibraryItx;
  const specUrl = "https://worker/expression/openapi.json?context=prj_x&itx=itx.svc.fetch";
  const connection = await connectToOpenApi(itx, specUrl);
  await connection.call("listPets");
  expect(seen[1]).toBe("GET https://worker/expression/api/pets?context=prj_x&itx=itx.svc.fetch");
});

// edge#6 — BUG (fixed): the reserved literal `{ "@": true }` leaked through the ARRAY half — `print`
// spelled it as `@` for EVERY expression, so a subscription target carrying it as data was stored,
// then silently dropped by the reduce (its parse refused the bare `@`), and a call carrying it broke
// the resolve/invoke law. FIX: `print` spells the markers only when asked (`{ holes: true }` — a rule
// target); the subscription door round-trips the array half through the codec.
describe("edge#6: the reserved literal is data everywhere but a rule's target", () => {
  test("a subscription target carrying { '@': true } is stored as data, listed, never dropped", () => {
    const event = subscriptionConfiguredEvent({
      name: "s",
      target: ["itx", "x", ["y", { "@": true }]],
    });
    expect((event.payload as { target: string }).target).toBe("itx.x.y({'@':true})");
    const state = reduced([event]);
    expect(state.subscriptions.s?.target).toEqual(["itx", "x", ["y", { "@": true }]]);
  });
  test("a call carrying the literal round-trips print → parse, so resolve's chain re-invokes as itself", () => {
    const call: ItxExpression = ["itx", ["a", { "@": true }, { "...@": true }]];
    expect(parse(print(call))).toEqual(call);
  });
  test("a rule's target still prints and stores the markers as `@` / `...@`", () => {
    const event = rewriteRuleConfiguredEvent(
      "itx.fable",
      "itx.builtins.ai.run('@cf/x', @, { ...@ })",
    );
    expect((event.payload as { target: string }).target).toBe(
      "itx.builtins.ai.run('@cf/x',@,{...@})",
    );
  });
});

// edge#7 — BUG (fixed): the ARRAY half of a match skipped the door — `["itx", "builtins.kv"]` stored a
// row rooted at the fixed point, `["itx", "cd.x"]` bypassed the proxy-verb refusal, `["itx", "a b"]`
// landed and the reduce silently skipped it. FIX: a prefix's name steps must be identifiers.
test("edge#7: the door reads the ARRAY half of a match exactly as the string half", () => {
  expect(() => rewriteRuleConfiguredEvent(["itx", "builtins.kv"], "itx.kv")).toThrow(/identifiers/);
  expect(() => rewriteRuleConfiguredEvent(["itx", "cd.x"], "itx.kv")).toThrow(/identifiers/);
  expect(() => rewriteRuleConfiguredEvent(["itx", "a b"], "itx.kv")).toThrow(/identifiers/);
  expect(() => rewriteRuleConfiguredEvent(["itx", ["builtins.kv", 1]], "itx.kv")).toThrow(
    /identifiers/,
  );
  expect(() => rewriteRuleConfiguredEvent(["itx", "__proto__"], "itx.kv")).toThrow(/reserved/);
  expect(rewriteRuleConfiguredEvent(["itx", "ok", ["get", 1]], "itx.kv")).toMatchObject({
    payload: { match: "itx.ok.get(1)" },
  });
});

// edge#10 — BUG (open): the `@` lexer and `matchingParen` do not know JSON5 comments: `@` in a comment
// is refused (or, with holes, markered) and a quote in a comment unbalances the parens. Exotic;
// either "no comments in expression args" gets stated in the header or both walkers learn `//` and
// `/* */`. Left red as the menu says.
test.fails("edge#10: a JSON5 comment inside call args is a comment, not a marker and not a quote", () => {
  expect(parse("itx.x(/* @ */ 1)")).toEqual(["itx", ["x", 1]]);
  expect(parse("itx.x(1 /* it's */, 2)")).toEqual(["itx", ["x", 1, 2]]);
});
