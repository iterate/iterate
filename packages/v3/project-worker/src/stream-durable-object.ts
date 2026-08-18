// stream-durable-object.ts — THE STREAM: one DO per `{projectId, path}` (codec-named
// `{projectId}.iterate{path}`). The stream is the parent — LOG + SOCKETS + DOORS only; the
// ITERATE CONTEXT (the routing table, iterate-context-stream-processor.ts) is a facet-hosted
// PROCESSOR on it (processor-facet.ts), one among many:
//
//   • the EVENT LOG — SQLite append/read, monotonic offsets, idempotency at the commit point;
//   • the PROCESSORS — every enabled one a workerd FACET driven after each commit (built-ins by
//     slug, userspace classes via the Worker Loader); the capability host (whose reduced state
//     is the routing table) is the built-in first member, lazily enabled on first use;
//   • the TRANSPORT — every hibernatable socket: relays park client/capability stubs behind
//     Pagers (core/hibernatable-stub.ts) so ANY number of connected providers leave this DO
//     free to hibernate; a live leg is borrowed per call burst only. The stub FACADE
//     (stubInvoke/stubFanOut/stubList/stubConnections/stubClose) is how the facet-hosted
//     capability host reaches the sockets — they can never move off the parent;
//   • the FETCH DOOR — the one place a 101 can enter: `x-itx-pager` accepts a Pager,
//     `x-itx-cap` forwards NATIVELY to the capability-host facet's fetch, anything else is
//     EGRESS (secret placeholder substitution → the FALLBACK terminal).
//
// PURE WORKERS-RPC: capnweb never terminates here (hard rule) — the stateless `/api` worker
// relays. Dispatch is ONE path: parse → route the table → substitute → evaluate → replay — all
// of it inside the iterate-context facet; this class only delegates. The dotted
// `invokeCapability(callPath, args)` door remains as the degenerate string half of the codec
// (loaded workers + the stateful runner speak it).

import { DurableObject } from "cloudflare:workers";
import { substituteHeaderSecrets } from "@v3/shared/egress";
import { ITX_SURFACE_MODULE } from "./core/agent-runtime.ts";
import {
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type StreamEvent,
  type StreamEventInput,
} from "./core/events.ts";
import { toExpression, type Expression } from "./core/expression.ts";
import { hashSource } from "./core/hash.ts";
import { PAGER_HEADER } from "./core/hibernatable-pager.ts";
import { HibernatableStubs, type Invoker, type Stub } from "./core/hibernatable-stub.ts";
import { parseName } from "./core/names.ts";
import type { FacetIdentity, ProcessorFacet } from "./processor-facet.ts";
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

/** One enabled facet-hosted processor: a built-in slug, or — with `ref` — USERSPACE code (a
 *  source expression resolved to modules + the exported DurableObject class name). */
type FacetProcessorEntry = {
  slug: string;
  ref?: { source: Expression; className: string };
};

/** The duck-typed contract BOTH facet kinds satisfy (the built-in ProcessorFacet and any
 *  loader-loaded userspace class): identity in, commit drives in, fold out. */
type FacetProcessorHandle = {
  configure(identity: FacetIdentity): Promise<unknown> | unknown;
  deliver(events: StreamEvent[], streamMaxOffset: number): Promise<unknown> | unknown;
  snapshot(): Promise<{ offset: number; state: unknown }>;
};

/** The capability host's slug — the one facet processor this class itself depends on. */
const ICTX_SLUG = "iterate-context";

export class StreamDurableObject extends DurableObject<Env> {
  // ── transport: the parked-stub registry over this DO's hibernatable sockets ──
  #stubs = new HibernatableStubs({
    acceptWebSocket: (ws, tags) => this.ctx.acceptWebSocket(ws, tags),
    getWebSockets: (tag) => this.ctx.getWebSockets(tag),
  });
  incarnation = 0; // durable, bumped per (re)construction — growth across idle ⇒ it hibernated

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
         offset INTEGER PRIMARY KEY AUTOINCREMENT,
         body TEXT NOT NULL,
         idempotency_key TEXT UNIQUE
       )`,
    );
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

  /** Commit events: idempotency-checked, offset-assigned, then every enabled facet processor
   *  driven. Reads stay read-after-write because every read path catches up from the log. */
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
      // THE FACET SPINE: drive every enabled facet-hosted processor (each an isolated workerd
      // facet with its own storage — including the iterate-context capability host itself).
      // Fire-and-forget ON PURPOSE: an awaited drive would deadlock if a facet processor
      // APPENDS during its batch (append → this method → await the same facet's busy chain) —
      // and the capability host DOES append (provide/revoke). Reads stay correct because every
      // snapshot/invoke catches up from the log first.
      for (const { slug } of this.#facetEntries())
        void this.#facet(slug)
          .then((f) => f.deliver(committed, head))
          .catch((e) => console.error(`facet "${slug}" deliver failed`, e));
    }
    return committed;
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
    await (await this.#facet(slug)).configure(this.#identityFor(slug));
    return { ok: true };
  }

  /** A facet processor's fold, served through the parent (catches up first). */
  async facetSnapshot(slug: string): Promise<{ offset: number; state: unknown }> {
    if (!this.#facetEntries().some((e) => e.slug === slug))
      throw new Error(`no facet processor "${slug}" enabled`);
    return (await this.#facet(slug)).snapshot();
  }

  #identityFor(slug: string): FacetIdentity {
    return {
      parentName: this.ctx.id.name ?? "?",
      projectId: this.#name.projectId,
      path: this.#name.path,
      slug,
    };
  }

  /** THE capability host — the iterate-context facet, lazily enabled + configured ONCE on first
   *  use (durable marker), and added to the driven set so every commit drives it too. */
  async #ictx(): Promise<ProcessorFacet> {
    const facet = (await this.#facet(ICTX_SLUG)) as unknown as ProcessorFacet;
    if (!this.ctx.storage.kv.get("ictx:enabled")) {
      await facet.configure(this.#identityFor(ICTX_SLUG));
      const entries = this.#facetEntries();
      if (!entries.some((e) => e.slug === ICTX_SLUG))
        this.ctx.storage.kv.put("facet-processors", [...entries, { slug: ICTX_SLUG }]);
      this.ctx.storage.kv.put("ictx:enabled", true);
    }
    return facet;
  }

  // ── dispatch (ONE path: the routing table — hosted in the iterate-context facet) ──

  /** Resolve + run one call (either codec half) against the current table. */
  async invoke(call: string | Expression, depth = 0): Promise<unknown> {
    return (await this.#ictx()).invoke(toExpression(call), depth);
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
    return (await this.#ictx()).provide(input);
  }

  async revokeCapability(input: { providedAtOffset: number }): Promise<void> {
    return (await this.#ictx()).revoke(input);
  }

  // ── native fetch: the pager door, the fetch lane, observability, egress ──

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // A relay opens its hibernatable Pager (the DO→relay back-channel; no pin).
    if (request.headers.get(PAGER_HEADER)) return this.#stubs.accept(request);

    // THE FETCH LANE: `x-itx-cap` rides NATIVELY into the capability-host facet's own fetch
    // (facet fetch tunnels a 101 — the stateful runner proves the pattern).
    if (request.headers.get("x-itx-cap")) return (await this.#ictx()).fetch(request);

    // Observability: incarnation (the hibernation tell) + the stub registry's live state.
    if (url.pathname === "/state")
      return Response.json({
        incarnation: this.incarnation,
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

  // ── the stub-registry FACADE (the clients view; sockets live HERE and can never move) ──
  // ONE registry, two access verbs: `stubInvoke` single-target (throws when offline);
  // `stubFanOut` per client path (allSettled — a dead connection drops out of the results).
  // The facet-hosted capability host builds its `itx.clients` view as thin RPC wrappers over
  // exactly these five methods (roots-builder.ts facetClientsView).

  #findStub(key: string): Stub {
    const s = this.#stubs.all().find((x) => x.connectionKey === key || x.socketId === key);
    if (!s) throw new Error(`client "${key}" is offline`);
    return s;
  }

  /** Invoke one parked stub by connectionKey/socketId (wake → borrowed leg → invoke). */
  stubInvoke(key: string, segments: string[], args: unknown[]): Promise<unknown> {
    return this.#stubs.invoke(this.#findStub(key).socketId, segments, args);
  }

  /** Fan out one method call over every open connection at a client path. */
  async stubFanOut(path: string, method: string[], args: unknown[]): Promise<unknown[]> {
    const settled = await Promise.allSettled(
      this.#stubs
        .all()
        .filter((s) => s.clientPath === path)
        .map((s) => this.#stubs.invoke(s.socketId, method, args)),
    );
    return settled
      .filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled")
      .map((r) => r.value);
  }

  /** The client roster, grouped by path. */
  stubList(): { path: string; description: unknown; connections: number }[] {
    const byPath = new Map<string, Stub[]>();
    for (const s of this.#stubs.all())
      if (typeof s.clientPath === "string")
        byPath.set(s.clientPath, [...(byPath.get(s.clientPath) ?? []), s]);
    return [...byPath.entries()].map(([p, list]) => ({
      path: p,
      description: list.at(-1)?.description ?? null,
      connections: list.length,
    }));
  }

  /** Every open connection at a client path. */
  stubConnections(
    path: string,
  ): { connectionKey: unknown; description: unknown; openedAt: unknown }[] {
    return this.#stubs
      .all()
      .filter((s) => s.clientPath === path)
      .map((s) => ({
        connectionKey: s.connectionKey,
        description: s.description,
        openedAt: s.openedAt,
      }));
  }

  /** Kick a connection by connectionKey/socketId (idempotent — unknown keys are a no-op). */
  stubClose(key: string): { ok: true } {
    const s = this.#stubs.all().find((x) => x.connectionKey === key || x.socketId === key);
    if (s) this.#stubs.drop(s.socketId, "kicked");
    return { ok: true };
  }
}
