// stream-durable-object.ts — THE STREAM: one DO per `{projectId, path}` (codec-named
// `{projectId}.iterate{path}`). The stream is the parent; the ITERATE CONTEXT is a PROCESSOR
// on it (iterate-context-stream-processor.ts — the routing table), one among many:
//
//   • the EVENT LOG — SQLite append/read, monotonic offsets, idempotency at the commit point;
//   • the PROCESSORS — a registry driven after every commit; the capability-host processor
//     (whose reduced state is the routing table) is the built-in first member;
//   • the TRANSPORT — every hibernatable socket: relays park client/capability stubs behind
//     Pagers (core/hibernatable-stub.ts) so ANY number of connected providers leave this DO
//     free to hibernate; a live leg is borrowed per call burst only;
//   • the FETCH DOOR — the one place a 101 can enter: `x-itx-pager` accepts a Pager,
//     `x-itx-cap` rides the fetch lane into a resolved capability, anything else is EGRESS
//     (secret placeholder substitution → the FALLBACK terminal).
//
// PURE WORKERS-RPC: capnweb never terminates here (hard rule) — the stateless `/api` worker
// relays. Dispatch is ONE path: parse → route the table → substitute → evaluate → replay.
// The dotted `invokeCapability(callPath, args)` door remains as the degenerate string half of
// the codec (loaded workers + the stateful runner speak it).

import { DurableObject } from "cloudflare:workers";
import { substituteHeaderSecrets } from "@v3/shared/egress";
import { IterateContextStreamProcessor } from "./iterate-context-stream-processor.ts";
import { CODE_CAP_RUNNER, ITX_SURFACE_MODULE } from "./core/agent-runtime.ts";
import { parseAppConfig } from "./core/config.ts";
import {
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type StreamEvent,
  type StreamEventInput,
} from "./core/events.ts";
import { parse, toExpression, type Expression } from "./core/expression.ts";
import { hashSource } from "./core/hash.ts";
import { PAGER_HEADER } from "./core/hibernatable-pager.ts";
import { HibernatableStubs, type Invoker, type Stub } from "./core/hibernatable-stub.ts";
import { parseName, stringifyName } from "./core/names.ts";
import { createStreamProcessorRegistry } from "./core/processor.ts";
import { Roots, type ClientsView, type WorkersView } from "./core/roots.ts";
import type { StatefulWorkerDurableObject } from "./stateful-worker-durable-object.ts";

interface Env {
  CONTEXT: DurableObjectNamespace<StreamDurableObject>;
  STATEFUL_WORKER: DurableObjectNamespace<StatefulWorkerDurableObject>;
  LOADER: WorkerLoader;
  ITX_KV?: KVNamespace;
  SECRETS_KV?: KVNamespace;
  APP_CONFIG?: string;
  /** Deploy identity — folded into loader cacheKeys so a redeploy mints fresh isolates (the
   *  stale-isolate/DataCloneError family the stateful runner documents). */
  CF_VERSION_METADATA?: { id: string };
  /** The shell this context's egress + `itx.os` bottom out at (a whole control plane). */
  FALLBACK: Fetcher & { invokeCapability(callPath: string, args?: unknown[]): Promise<unknown> };
}

// The v1 "file reader" behind `itx.files.read` — provides hello modules (no repo/bundler yet).
// A real repo-read-at-a-ref later slots in behind the SAME capability + source expressions.
const HELLO_FILES: Record<string, string> = {
  "/hello.js": `export default (itx, name) => "hello " + (name ?? "world");`,
  "/counter.js": `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async increment(by) { const n = ((await this.ctx.storage.get("n")) ?? 0) + by; await this.ctx.storage.put("n", n); return n; }
  async value() { return (await this.ctx.storage.get("n")) ?? 0; }
  async whoAmI() { return await this.env.ITX.invokeCapability("itx.whoami", []); }
  // A NESTED surface — proves the runner's deep dotted dispatch.
  get counters() {
    const self = this;
    return { async add(by) { return self.increment(by); } };
  }
}`,
  // A USERSPACE facet processor (duck-typed contract: configure/deliver/snapshot) — hosted as a
  // workerd facet on the Stream DO via enableProcessor(slug, { source, className }). It keeps its
  // own cursor + counts in its OWN facet storage; snapshot catches up from the stream via env.ITX
  // (the parent stub) so reads are never stale even though drives are fire-and-forget.
  "/user-tally.js": `import { DurableObject } from "cloudflare:workers";
export class UserTally extends DurableObject {
  configure() {} // identity unused — env.ITX already IS this stream
  #fold(events) {
    let offset = this.ctx.storage.kv.get("offset") ?? 0;
    const counts = this.ctx.storage.kv.get("counts") ?? {};
    for (const e of events)
      if (e.offset > offset) { counts[e.type] = (counts[e.type] ?? 0) + 1; offset = e.offset; }
    this.ctx.storage.kv.put("counts", counts);
    this.ctx.storage.kv.put("offset", offset);
    return { offset, state: { counts } };
  }
  deliver(events) { this.#fold(events); }
  async snapshot() {
    return this.#fold(await this.env.ITX.read(this.ctx.storage.kv.get("offset") ?? 0));
  }
}`,
  // A fetch-serving stateless worker: an HTTP page AND a WebSocket upgrade (101) — the stand-in
  // for "a device presents a website with WebSocket functionality", reached on the fetch lane.
  "/site.js": `export default {
  async fetch(request) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener("message", (e) => pair[1].send("site-echo:" + e.data));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("<!doctype html><title>dynamic site</title><h1>hello from a dynamic web capability</h1>", { headers: { "content-type": "text/html" } });
  }
};`,
};

/** One enabled facet-hosted processor: a built-in slug, or — with `ref` — USERSPACE code (a
 *  source expression resolved to modules + the exported DurableObject class name). */
type FacetProcessorEntry = {
  slug: string;
  ref?: { source: Expression; className: string };
};

/** The duck-typed contract BOTH facet kinds satisfy (the built-in ProcessorFacet and any
 *  loader-loaded userspace class): identity in, commit drives in, fold out. */
type FacetProcessorHandle = {
  configure(identity: import("./processor-facet.ts").FacetIdentity): Promise<unknown> | unknown;
  deliver(events: StreamEvent[], streamMaxOffset: number): Promise<unknown> | unknown;
  snapshot(): Promise<{ offset: number; state: unknown }>;
};

export class StreamDurableObject extends DurableObject<Env> {
  // ── transport: the parked-stub registry over this DO's hibernatable sockets ──
  #stubs = new HibernatableStubs({
    acceptWebSocket: (ws, tags) => this.ctx.acceptWebSocket(ws, tags),
    getWebSockets: (tag) => this.ctx.getWebSockets(tag),
  });
  incarnation = 0; // durable, bumped per (re)construction — growth across idle ⇒ it hibernated
  // Declared BEFORE #registry/#capHost: their field initializers call #roots(), and private
  // fields are installed on `this` in declaration order — reading one that isn't yet declared
  // throws (found live: "Cannot read private member #rootsInstance").
  #rootsInstance?: Roots;

  // ── the processors: registry + the built-in capability host ──
  #registry = createStreamProcessorRegistry({
    storage: {
      get: <T>(k: string) => this.ctx.storage.kv.get(k) as T | undefined,
      put: (k: string, v: unknown) => this.ctx.storage.kv.put(k, v),
    },
    stream: { append: (...e) => this.append(...e), read: (a, l) => this.read(a, l) },
    path: this.#name.path,
    projectId: this.#name.projectId,
  });
  #capHost = this.#registry.register(
    new IterateContextStreamProcessor({
      stream: { append: (...e) => this.append(...e), read: (a, l) => this.read(a, l) },
      path: this.#name.path,
      projectId: this.#name.projectId,
      seeds: parseAppConfig(this.env.APP_CONFIG).seeds,
      roots: this.#roots(),
    }),
  );
  #capReads = this.#registry.reads(this.#capHost);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
         offset INTEGER PRIMARY KEY AUTOINCREMENT,
         body TEXT NOT NULL,
         idempotency_key TEXT UNIQUE
       )`,
    );
    // wire the resolver recursion: `itx.…` inside any mount target re-enters dispatch
    this.#capHost.resolveCurrent = (call, depth) => this.invoke(call, depth);
    ctx.blockConcurrencyWhile(async () => {
      this.incarnation = ((await ctx.storage.get<number>("incarnation")) ?? 0) + 1;
      await ctx.storage.put("incarnation", this.incarnation);
    });
  }

  /** The context this DO is — parsed from its unforgeable codec name. */
  get #name(): { projectId: string; path: string } {
    return parseName(this.ctx.id.name ?? "?");
  }

  // ── the event log (the commit point) ──

  /** Commit events: idempotency-checked, offset-assigned, then processors driven to head.
   *  Awaiting delivery keeps read-after-write: a provide followed by an invoke sees the mount. */
  async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    const committed: StreamEvent[] = [];
    for (const input of inputs) {
      if (input.idempotencyKey) {
        const hit = this.ctx.storage.sql
          .exec("SELECT offset, body FROM events WHERE idempotency_key = ?", input.idempotencyKey)
          .toArray()[0];
        if (hit) {
          const existing = JSON.parse(String(hit.body)) as StreamEventInput;
          if (sameIdempotentEvent(existing, input)) {
            committed.push({
              ...existing,
              offset: Number(hit.offset),
              path: this.#name.path,
            } as StreamEvent);
            continue;
          }
          throw new Error(idempotencyConflictMessage(input.idempotencyKey, Number(hit.offset)));
        }
      }
      const body = { ...input, createdAt: new Date(Date.now()).toISOString() };
      this.ctx.storage.sql.exec(
        "INSERT INTO events (body, idempotency_key) VALUES (?, ?)",
        JSON.stringify(body),
        input.idempotencyKey ?? null,
      );
      const offset = Number(this.ctx.storage.sql.exec("SELECT last_insert_rowid() AS o").one().o);
      committed.push({ ...body, offset, path: this.#name.path } as StreamEvent);
    }
    if (committed.length) {
      const head = committed[committed.length - 1].offset;
      await this.#registry.deliver(committed, head);
      // THE FACET SPINE: drive every enabled facet-hosted processor too (each an isolated
      // workerd facet with its own storage — see processor-facet.ts). Fire-and-forget ON
      // PURPOSE: an awaited drive would deadlock if a facet processor APPENDS during its
      // batch (append → this method → await the same facet's busy chain). Reads stay correct
      // because facetSnapshot() always catches up from the log first.
      for (const { slug } of this.#facetEntries())
        void this.#facet(slug)
          .then((f) => f.deliver(committed, head))
          .catch((e) => console.error(`facet "${slug}" deliver failed`, e));
    }
    return committed;
  }

  // ── facet-hosted processors (built-ins via processor-facet.ts; userspace via the LOADER) ──

  #facetEntries(): FacetProcessorEntry[] {
    return (this.ctx.storage.kv.get("facet-processors") as FacetProcessorEntry[] | undefined) ?? [];
  }

  /** Materialize (or reuse) the facet hosting `slug`. A stored `ref` means USERSPACE: the class
   *  arrives via the Worker Loader (source resolved through this context's own dispatch — the
   *  same repo-agnostic resolution as dynamic workers) instead of the built-in ProcessorFacet.
   *  Both speak the same duck-typed contract: configure / deliver / snapshot. */
  async #facet(slug: string): Promise<FacetProcessorHandle> {
    const ref = this.#facetEntries().find((e) => e.slug === slug)?.ref;
    if (!ref) {
      const exports = (this.ctx as unknown as { exports: Record<string, unknown> }).exports;
      return this.ctx.facets.get(`proc:${slug}`, () => ({
        class: exports.ProcessorFacet as DurableObjectClass,
      })) as unknown as FacetProcessorHandle;
    }
    const modules = (await this.invoke(ref.source)) as Record<string, string>;
    const version = hashSource(JSON.stringify(modules));
    const v = this.env.CF_VERSION_METADATA?.id ?? "unversioned";
    const self = this.env.CONTEXT.getByName(this.ctx.id.name ?? "?");
    const worker = this.env.LOADER.get(
      // Deploy id in the key (the stale-isolate/DataCloneError family): see the stateful runner.
      `procfacet:${v}:${this.ctx.id.name}:${slug}:${version}`,
      () => ({
        compatibilityDate: "2026-07-01",
        mainModule: "cap.js",
        modules: { "itx.js": ITX_SURFACE_MODULE, ...modules },
        env: { ITX: self },
        globalOutbound: self,
      }),
    );
    const klass = worker.getDurableObjectClass(ref.className);
    if (!klass) throw new Error(`userspace processor "${slug}": no class "${ref.className}"`);
    // Abort + recreate the facet on a source change, KEEPING its storage — the stateful runner's
    // version-marker pattern, keyed per slug. The parent only ever calls the duck-typed methods
    // directly (facet.configure/deliver/snapshot), which is Reflect.apply-safe by construction.
    const markerKey = `procfacet:${slug}:version`;
    const prev = this.ctx.storage.kv.get(markerKey) as string | undefined;
    if (prev !== undefined && prev !== version)
      this.ctx.facets.abort(`proc:${slug}`, "source changed");
    if (prev !== version) this.ctx.storage.kv.put(markerKey, version);
    return this.ctx.facets.get(`proc:${slug}`, () => ({
      class: klass,
    })) as unknown as FacetProcessorHandle;
  }

  /** Enable a facet-hosted processor on this stream (idempotent; identity configured durably).
   *  With a `ref` the processor is USERSPACE code: `source` (an expression resolved to modules)
   *  + the exported `className` — stored durably so every incarnation rebuilds the same facet. */
  async enableProcessor(
    slug: string,
    ref?: { source: string | Expression; className: string },
  ): Promise<{ ok: true }> {
    const entry: FacetProcessorEntry = ref
      ? { slug, ref: { source: toExpression(ref.source), className: ref.className } }
      : { slug };
    const others = this.#facetEntries().filter((e) => e.slug !== slug);
    this.ctx.storage.kv.put("facet-processors", [...others, entry]);
    await (
      await this.#facet(slug)
    ).configure({
      parentName: this.ctx.id.name ?? "?",
      projectId: this.#name.projectId,
      path: this.#name.path,
      slug,
    });
    return { ok: true };
  }

  /** A facet processor's fold, served through the parent (catches up first). */
  async facetSnapshot(slug: string): Promise<{ offset: number; state: unknown }> {
    if (!this.#facetEntries().some((e) => e.slug === slug))
      throw new Error(`no facet processor "${slug}" enabled`);
    return (await this.#facet(slug)).snapshot();
  }

  read(afterOffset = 0, limit = 500): StreamEvent[] {
    return this.ctx.storage.sql
      .exec(
        "SELECT offset, body FROM events WHERE offset > ? ORDER BY offset LIMIT ?",
        afterOffset,
        limit,
      )
      .toArray()
      .map((r) => ({
        ...(JSON.parse(String(r.body)) as StreamEventInput & { createdAt: string }),
        offset: Number(r.offset),
        path: this.#name.path,
      }));
  }

  // ── dispatch (ONE path: the routing table) ──

  /** Resolve + run one call (either codec half) against the current table. */
  async invoke(call: string | Expression, depth = 0): Promise<unknown> {
    const state = (await this.#capReads.snapshot()).state; // snapshot itself catches up first
    return this.#capHost.resolve(state, toExpression(call), undefined, depth);
  }

  /** The dotted door — the degenerate string half. Loaded workers' `itx.js` + the runner speak
   *  this (`itx.a.b(args)` ⇒ ["itx","a",["b",...args]]). */
  invokeCapability(callPath: string, args: unknown[] = []): Promise<unknown> {
    const segments = callPath.split(".");
    const last = segments.at(-1)!;
    return this.invoke([...segments.slice(0, -1), [last, ...args]] as Expression);
  }

  /** Mount a capability (event provenance — `roots` targets are rejected). */
  async provideCapability(input: {
    pattern: string | Expression;
    target: string | Expression;
  }): Promise<{ providedAtOffset: number }> {
    return this.#capHost.provide(input);
  }

  async revokeCapability(input: { providedAtOffset: number }): Promise<void> {
    return this.#capHost.revoke(input);
  }

  // ── native fetch: the pager door, the fetch lane, observability, egress ──

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // A relay opens its hibernatable Pager (the DO→relay back-channel; no pin).
    if (request.headers.get(PAGER_HEADER)) return this.#stubs.accept(request);

    // THE FETCH LANE: `x-itx-cap` carries an expression (either half); terminal-`fetch` rule.
    const capHeader = request.headers.get("x-itx-cap");
    if (capHeader) {
      try {
        const expr = capHeader.trimStart().startsWith("[")
          ? (JSON.parse(capHeader) as Expression)
          : parse(capHeader.startsWith("itx") ? capHeader : `itx.${capHeader}`);
        const state = (await this.#capReads.snapshot()).state; // snapshot catches up first
        const result = await this.#capHost.resolveFetch(state, expr, request);
        if (result instanceof Response) return result;
        return new Response(`fetch lane: ${JSON.stringify(result)}\n`);
      } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        const status = /no capability matches/.test(message) ? 404 : 500;
        return new Response(`fetch lane error: ${message}\n`, { status });
      }
    }

    // Observability: incarnation (the hibernation tell) + the stub registry's live state.
    if (url.pathname === "/state")
      return Response.json({
        incarnation: this.incarnation,
        processors: this.#registry.names,
        facetProcessors: this.#facetEntries().map((e) => e.slug),
        ...this.#stubs.state(),
      });

    // EGRESS: substitute `{{secret:NAME}}` placeholders, then the FALLBACK terminal.
    const sub = await substituteHeaderSecrets(request, "project", (name) =>
      this.env.SECRETS_KV
        ? this.env.SECRETS_KV.get(`secret:${this.#name.projectId}:${name}`)
        : null,
    );
    return this.env.FALLBACK.fetch(sub);
  }

  webSocketMessage(): void {
    // A Pager is DO→relay only — inbound frames carry nothing we act on.
  }
  webSocketClose(ws: WebSocket): void {
    this.#stubs.closed(ws); // relay gone → its parked stubs vanish with the socket
  }
  webSocketError(ws: WebSocket): void {
    this.#stubs.closed(ws);
  }

  // ── relay-facing transport RPC (the edge parks/activates/drops stubs) ──

  /** Park a live capability's stub; the caller then mounts `itx.clients.get(socketId)` at its
   *  pattern (provide = park + alias — the R13 desugar, done BY the edge in two calls). */
  parkCapability(input: { socketId: string; description?: string }): { ok: true } {
    this.#stubs.park(input.socketId, { description: input.description });
    return { ok: true };
  }
  /** Park a `.connect` client connection (reconnect under the same key replaces its predecessor). */
  parkClient(input: {
    socketId: string;
    path: string;
    connectionKey: string;
    description?: string;
  }): { ok: true; connectionKey: string } {
    for (const s of this.#stubs.all())
      if (
        s.clientPath === input.path &&
        s.connectionKey === input.connectionKey &&
        s.socketId !== input.socketId
      )
        this.#stubs.drop(s.socketId, "replaced");
    this.#stubs.park(input.socketId, {
      clientPath: input.path,
      connectionKey: input.connectionKey,
      description: input.description,
      openedAt: new Date(Date.now()).toISOString(),
    });
    return { ok: true, connectionKey: input.connectionKey };
  }
  /** Wake handshake: the woken relay lends its short Workers-RPC leg for one burst. */
  activateStub(input: { socketId: string; invoker: Invoker }) {
    return this.#stubs.activate(input);
  }
  dropStub(input: { socketId: string }): { ok: true } {
    this.#stubs.drop(input.socketId, "dropped");
    return { ok: true };
  }

  // ── roots (built once; every getter closes over this context's identity) ──

  #roots(): Roots {
    if (this.#rootsInstance) return this.#rootsInstance;
    const { projectId, path } = this.#name;
    this.#rootsInstance = new Roots({
      projectId,
      path,
      itxKv: this.env.ITX_KV,
      secretsKv: this.env.SECRETS_KV,
      binding: (name) => {
        if (name !== "FALLBACK") throw new Error(`roots.binding: no binding "${name}"`);
        return this.env.FALLBACK;
      },
      context: (p) =>
        p === path
          ? {
              append: (...e) => this.append(...(e as StreamEventInput[])),
              read: (a, l) => this.read(a, l),
            }
          : this.env.CONTEXT.getByName(stringifyName({ projectId, path: p })),
      clients: this.#clientsView(),
      workers: this.#workersView(),
      readFile: (p) => {
        const content = HELLO_FILES[p];
        if (content == null) throw new Error(`roots.files: no file "${p}"`);
        return { "cap.js": content };
      },
    });
    return this.#rootsInstance;
  }

  /** ONE registry, two access verbs: `get(key)` single-target (throws when offline);
   *  `at(path)` fan-out (allSettled — a dead connection drops out of the results). */
  #clientsView(): ClientsView {
    const stubs = this.#stubs;
    const find = (key: string): Stub => {
      const s = stubs.all().find((x) => x.connectionKey === key || x.socketId === key);
      if (!s) throw new Error(`client "${key}" is offline`);
      return s;
    };
    const proxyFor = (key: string, segments: string[]): unknown =>
      new Proxy(function () {} as object, {
        get: (_t, p) =>
          p === "then" || typeof p === "symbol"
            ? undefined
            : proxyFor(key, [...segments, p as string]),
        apply: (_t, _this, args) => stubs.invoke(find(key).socketId, segments, args as unknown[]),
      });
    return {
      get: (key) => (find(key), proxyFor(key, [])),
      at: (path) => ({
        call: async (method, args) => {
          const settled = await Promise.allSettled(
            stubs
              .all()
              .filter((s) => s.clientPath === path)
              .map((s) => stubs.invoke(s.socketId, method, args)),
          );
          return settled
            .filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled")
            .map((r) => r.value);
        },
      }),
      list: () => {
        const byPath = new Map<string, Stub[]>();
        for (const s of stubs.all())
          if (typeof s.clientPath === "string")
            byPath.set(s.clientPath, [...(byPath.get(s.clientPath) ?? []), s]);
        return [...byPath.entries()].map(([p, list]) => ({
          path: p,
          description: list.at(-1)?.description ?? null,
          connections: list.length,
        }));
      },
      connections: (path) =>
        stubs
          .all()
          .filter((s) => s.clientPath === path)
          .map((s) => ({
            connectionKey: s.connectionKey,
            description: s.description,
            openedAt: s.openedAt,
          })),
      close: (key) => {
        const s = stubs.all().find((x) => x.connectionKey === key || x.socketId === key);
        if (s) stubs.drop(s.socketId, "kicked");
        return { ok: true };
      },
    };
  }

  /** `roots.workers.get({type, source, className?})` — run code in this context.
   *  stateless → a loader isolate: `{ run(...args), fetch(request) }`;
   *  stateful  → the runner DO's facet: any (deep dotted) method + fetch. */
  #workersView(): WorkersView {
    return {
      get: (ref) => {
        const source = toExpression(ref.source as string | Expression);
        if (ref.type === "stateless") {
          return {
            run: async (...args: unknown[]) => {
              const modules = await this.#loadModules(source);
              const v = this.env.CF_VERSION_METADATA?.id ?? "unversioned";
              const worker = this.#worker(
                `code:${v}:${this.ctx.id.name}:${hashSource(JSON.stringify(modules))}`,
                "run.js",
                { "run.js": CODE_CAP_RUNNER, ...modules },
              );
              const resp = await worker.getEntrypoint().fetch(
                new Request("https://code.local/", {
                  method: "POST",
                  body: JSON.stringify(args),
                }),
              );
              return ((await resp.json()) as { result: unknown }).result;
            },
            fetch: async (request: Request) => {
              const modules = await this.#loadModules(source);
              const v = this.env.CF_VERSION_METADATA?.id ?? "unversioned";
              const worker = this.#worker(
                `code-fetch:${v}:${this.ctx.id.name}:${hashSource(JSON.stringify(modules))}`,
                "cap.js",
                modules,
              );
              return worker.getEntrypoint().fetch(request);
            },
          };
        }
        // stateful: a method proxy onto the dedicated runner DO (deep dots ride the wire joined,
        // the runner walks segments). fetch forwards natively so a 101 passes through.
        const className = ref.className;
        if (!className) throw new Error("workers.get: stateful ref needs a className");
        const runner = this.env.STATEFUL_WORKER.getByName(
          `${this.#name.projectId}::${this.#name.path}::${className}:${hashSource(JSON.stringify(source))}`,
        );
        const proxyFor = (segments: string[]): unknown =>
          new Proxy(function () {} as object, {
            get: (_t, p) => {
              if (p === "then" || typeof p === "symbol") return undefined;
              if (p === "fetch" && segments.length === 0)
                return (request: Request) => {
                  const headers = new Headers(request.headers);
                  headers.set("x-itx-source", JSON.stringify(source));
                  headers.set("x-itx-class", className);
                  return runner.fetch(new Request(request, { headers }));
                };
              return proxyFor([...segments, p as string]);
            },
            apply: (_t, _this, args) =>
              runner.invokeCapability({
                source,
                className,
                method: segments.join("."),
                args: args as unknown[],
              }),
          });
        return proxyFor([]);
      },
    };
  }

  /** Evaluate a source expression through THIS context's own dispatch into a modules map. */
  async #loadModules(source: Expression): Promise<Record<string, string>> {
    return (await this.invoke(source)) as Record<string, string>;
  }

  /** Load a confined dynamic worker: `itx.js` injected, env.ITX = globalOutbound = a self-stub. */
  #worker(cacheKey: string, mainModule: string, modules: Record<string, string>) {
    const self = this.env.CONTEXT.getByName(this.ctx.id.name ?? "?");
    return this.env.LOADER.get(cacheKey, () => ({
      compatibilityDate: "2026-07-01",
      mainModule,
      modules: { "itx.js": ITX_SURFACE_MODULE, ...modules },
      env: { ITX: self },
      globalOutbound: self,
    }));
  }
}
