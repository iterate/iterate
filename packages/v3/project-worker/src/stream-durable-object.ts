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
import { confinedWorker, PROCESSOR_RUNNER_MODULE } from "./core/agent-runtime.ts";
import { codedError } from "./core/errors.ts";
import {
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type StreamEvent,
  type StreamEventInput,
} from "./core/events.ts";
import { stepGet, toExpression, type Expression } from "./core/expression.ts";
import { hashSource } from "./core/hash.ts";
import { PAGER_HEADER } from "./core/hibernatable-pager.ts";
import { HibernatableStubs, type Invoker, type Stub } from "./core/hibernatable-stub.ts";
import { parseName } from "./core/names.ts";
import type { ScanWindow } from "./core/processor.ts";
import { PROCESSOR_SDK_MODULE } from "./generated/processor-sdk.ts";
import type { FacetIdentity, ProcessorFacet } from "./processor-facet.ts";

// What THIS class touches of the shared worker env (the facets see the rest — a built-in facet
// inherits the whole worker env; see roots-builder.ts RootsEnv).
interface Env {
  CONTEXT: DurableObjectNamespace<StreamDurableObject>;
  LOADER: WorkerLoader;
  SECRETS_KV?: KVNamespace;
  /** Deploy identity — folded into loader cacheKeys so a redeploy mints fresh isolates (the
   *  stale-isolate/DataCloneError family the stateful runner documents). */
  CF_VERSION_METADATA?: { id: string };
  /** The shell this context's egress bottoms out at (a whole control plane). */
  FALLBACK: Fetcher;
}

/** One enabled facet-hosted processor: a built-in slug, or — with `ref` — USERSPACE code (a
 *  source expression resolved to modules + which export is the StreamProcessor subclass). */
type FacetProcessorEntry = {
  slug: string;
  ref?: { source: Expression; export: string };
};

/** The duck-typed contract BOTH facet kinds satisfy (the built-in ProcessorFacet and the
 *  SDK-injected runner.js): identity in, pushed windows in, fold + barrier out. */
type FacetProcessorHandle = {
  configure(identity: FacetIdentity): Promise<unknown> | unknown;
  processEventBatch(events: StreamEvent[], window: ScanWindow): Promise<unknown> | unknown;
  snapshot(): Promise<{ offset: number; state: unknown }>;
  waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<unknown>;
};

/** One push subscription: `target` is an itx path expression whose terminal segment the sender
 *  calls with `(events, window)`; the stream owns the cursor. */
type PushRow = {
  name: string;
  target: Expression;
  consumes?: string[];
  onFailingEvent: "halt" | "skip";
  /** Retries before the policy speaks. Default 15 (~2h of backoff); a webhook that would
   *  rather fail fast can say so. */
  maxAttempts?: number;
};
/** The stream-held cursor + failure ladder state for one push row. */
type PushCursor = {
  confirmedOffset: number;
  attempt: number; // consecutive failures of the CURRENT batch
  skipsSinceSuccess: number;
  pinned?: boolean; // after a failure: batch size 1 (isolate-or-progress)
  nextAttemptAtMs?: number;
  halted?: { reason: string };
};

/** The capability host's slug — the one facet processor this class itself depends on. */
const ICTX_SLUG = "iterate-context";

export class StreamDurableObject extends DurableObject<Env> {
  // ── transport: the parked-stub registry over this DO's hibernatable sockets ──
  #stubs = new HibernatableStubs({
    acceptWebSocket: (ws, tags) => this.ctx.acceptWebSocket(ws, tags),
    getWebSockets: (tag) => this.ctx.getWebSockets(tag),
  });
  incarnation = 0; // durable, bumped once per incarnation that WRITES — growth across idle ⇒ it hibernated
  #storageReady = false;

  // The constructor deliberately touches NO storage: a DO that never writes must never mint
  // backing storage (workerd auto-deletes empty objects, and a probed /state or typo'd ctx must
  // leave nothing behind — the Kenton PR #6101 doctrine). All writes funnel through #touch().

  /** First write of this incarnation: name-check BEFORE anything persists, then the events
   *  table + one incarnation bump (the hibernation tell — workless incarnations no longer
   *  count, which is the point). Synchronous (the kv API), so append needs no boot barrier. */
  #touch(): void {
    if (this.#storageReady) return;
    void this.#doName; // an id-addressed instance must fail before its first write
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
         offset INTEGER PRIMARY KEY AUTOINCREMENT,
         body TEXT NOT NULL,
         idempotency_key TEXT UNIQUE
       )`,
    );
    this.incarnation = ((this.ctx.storage.kv.get("incarnation") as number | undefined) ?? 0) + 1;
    this.ctx.storage.kv.put("incarnation", this.incarnation);
    this.#storageReady = true;
  }

  /** This DO's codec name. A stream is only ever reached `getByName` — an id-addressed instance
   *  has no identity and must fail before it writes anything. */
  get #doName(): string {
    const name = this.ctx.id.name;
    if (!name) throw new Error("StreamDurableObject requires a named id (reach it via getByName)");
    return name;
  }

  /** The context this DO is — parsed from its unforgeable codec name. */
  get #name(): { projectId: string; path: string } {
    return parseName(this.#doName);
  }

  // ── the event log (the commit point) ──

  /** The highest offset EVER ASSIGNED — including to ephemeral events whose bodies are gone.
   *  Backed by ONE tiny kv value (the deliberate write that makes a pure-ephemeral append cost
   *  exactly one storage write): offset REUSE after an incarnation dies is a data-corruption
   *  class, because consumers key durable truth by offset. */
  #maxAssignedCache?: number;
  #maxAssigned(): number {
    if (this.#maxAssignedCache !== undefined) return this.#maxAssignedCache;
    const kvHigh = (this.ctx.storage.kv.get("maxAssignedOffset") as number | undefined) ?? 0;
    const sqlHigh = this.#eventsTableExists()
      ? Number(this.ctx.storage.sql.exec("SELECT COALESCE(MAX(offset),0) AS m FROM events").one().m)
      : 0;
    this.#maxAssignedCache = Math.max(kvHigh, sqlHigh);
    return this.#maxAssignedCache;
  }

  #eventsTableExists(): boolean {
    return (
      this.#storageReady ||
      this.ctx.storage.sql
        .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'")
        .toArray().length > 0
    );
  }

  /** Commit events: idempotency-checked, offsets assigned from ONE shared sequence (ephemeral
   *  events consume offsets but never touch the log — their bodies exist only in this batch and
   *  in whatever pushes deliver them; after a reboot their offsets survive as valid gaps), then
   *  every enabled facet processor is PUSHED the batch with its scan-window proof. */
  async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    this.#touch();
    const committed: StreamEvent[] = [];
    const scannedAfterOffset = this.#maxAssigned();
    let nextOffset = scannedAfterOffset;
    for (const input of inputs) {
      if (input.ephemeral && input.idempotencyKey)
        throw new Error(
          "ephemeral events cannot carry an idempotencyKey — nothing idempotent about the unreplayable",
        );
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
            continue; // a dedupe hit consumes NO offset
          }
          throw codedError(
            "IDEMPOTENCY_CONFLICT",
            idempotencyConflictMessage(input.idempotencyKey, Number(hit.offset)),
            { existingOffset: Number(hit.offset) },
          );
        }
      }
      nextOffset += 1;
      const body = { ...input, createdAt: new Date().toISOString() };
      if (!input.ephemeral) {
        this.ctx.storage.sql.exec(
          "INSERT INTO events (offset, body, idempotency_key) VALUES (?, ?, ?)",
          nextOffset,
          JSON.stringify(body),
          input.idempotencyKey ?? null,
        );
      }
      committed.push({ ...body, offset: nextOffset, path: this.#name.path } as StreamEvent);
    }
    if (nextOffset > scannedAfterOffset) {
      this.ctx.storage.kv.put("maxAssignedOffset", nextOffset); // THE one deliberate write
      this.#maxAssignedCache = nextOffset;
      const window = { scannedAfterOffset, scannedThroughOffset: nextOffset };
      // THE PUMP: push the batch + window into every enabled facet processor (each an isolated
      // workerd facet with its own storage — including the iterate-context capability host).
      // Fire-and-forget ON PURPOSE: an awaited drive would deadlock if a facet processor
      // APPENDS during its batch (append → this method → await the same facet's busy chain) —
      // and the capability host DOES append (provide/revoke). Reads stay correct because every
      // snapshot/invoke gap-repairs from the log; only ephemeral bodies are unrepairable, by
      // design. The push itself is what wakes an aborted facet.
      for (const { slug } of this.#facetEntries())
        void this.#facet(slug)
          .then((f) => f.processEventBatch(committed, window))
          .catch((e) => console.error(`facet "${slug}" drive failed`, e));
      this.#drivePushRows(); // push rows read durable rows themselves — also never awaited
    }
    this.#noteActivity();
    return committed;
  }

  read(afterOffset = 0, limit = 500): { events: StreamEvent[]; scannedThroughOffset: number } {
    // A virgin stream has no events table (and reading must not create one — see #touch).
    if (!this.#eventsTableExists()) return { events: [], scannedThroughOffset: afterOffset };
    const events = this.ctx.storage.sql
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
    // The scan-window proof: a FULL page is only contiguously known through its last row; a
    // short page proves the read scanned to the head (ephemeral holes and all).
    const scannedThroughOffset =
      events.length === limit
        ? events[events.length - 1].offset
        : Math.max(afterOffset, this.#maxAssigned());
    return { events, scannedThroughOffset };
  }

  // ── the #6800 quiesce: idle facets un-pinned so this actor can hibernate ──

  #lastActivityMs = 0;
  #noteActivity(): void {
    this.#lastActivityMs = Date.now();
    void this.#armAlarmNoLaterThan(this.#lastActivityMs + 60_000).catch(() => {});
  }
  /** ONE alarm write per quiet-period start, never per append (an ephemeral flood arms once). */
  async #armAlarmNoLaterThan(target: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > target) await this.ctx.storage.setAlarm(target);
  }
  // In-memory on purpose: a fresh incarnation always runs one resurrection pass, and losing
  // the flag with an eviction is exactly the point.
  #facetsResurrected = false;

  async alarm(): Promise<void> {
    this.#drivePushRows(); // retries whose backoff came due
    if (!this.#facetsResurrected) {
      // THE RESURRECTION PASS: a fold interrupted by eviction, with no follow-up traffic,
      // would otherwise stall until the next append (the pump only fires on commits). The
      // first alarm of each incarnation asks every facet for a snapshot — which IS its
      // catch-up: a behind facet gap-repairs from its own durable cursor, a caught-up one
      // no-ops. Quiesce/abort waits for a later pass so it can never race a fold it revived.
      this.#facetsResurrected = true;
      for (const { slug } of this.#facetEntries())
        void this.#facet(slug)
          .then((f) => f.snapshot())
          .catch((e) => console.error(`facet "${slug}" resurrection failed`, e));
      await this.#armAlarmNoLaterThan(Date.now() + 60_000);
    } else if (Date.now() - this.#lastActivityMs >= 60_000) {
      // workerd #6800: a live facet client holds this actor idle-but-non-hibernatable,
      // converting quiet time into billed duration. Abort every facet once the stream has been
      // quiet — their cursors are durable in their OWN storage and delivery is cursor-driven,
      // so nothing is lost (replies are output-gated; abort keeps storage; rebuild ~50-700ms).
      for (const { slug } of this.#facetEntries()) {
        try {
          this.ctx.facets.abort(`proc:${slug}`, "idle quiesce");
        } catch {
          /* facet not running — already quiesced */
        }
      }
    } else {
      await this.#armAlarmNoLaterThan(this.#lastActivityMs + 60_000);
    }
    // keep the earliest pending push retry armed (the arms above may be later)
    const dues = this.#pushRows()
      .map((r) => this.#pushCursor(r.name)?.nextAttemptAtMs)
      .filter((t): t is number => typeof t === "number");
    if (dues.length) await this.#armAlarmNoLaterThan(Math.min(...dues));
  }

  // ── PUSH SUBSCRIPTIONS: the stream-held cursor + the retry/skip/halt ladder ──
  // For consumers that CANNOT hold a cursor (a webhook, the stateless `processEvent`-style
  // worker). The row's `target` is a path expression; the sender turns its terminal segment
  // into the call `(events, window)` per batch, and the AWAITED call resolving IS the ack.
  // Push rows never see ephemeral events (reads are durable-only); their cursor still advances
  // over ephemeral offsets via scan windows. There is no dead-letter queue on purpose: the
  // ladder is bounded retries (1s·2^n, cap 30min, ±20% jitter, 15 attempts) → poison isolation
  // (`onFailingEvent: "skip"`: pin the batch to 1, three failures → skip + audit event) →
  // HALT (audited, resumable) — the apps/os shape, one mode instead of three kinds.

  #pushInFlight = new Set<string>();
  #pushRows(): PushRow[] {
    return (this.ctx.storage.kv.get("push-subscriptions") as PushRow[] | undefined) ?? [];
  }
  #pushCursor(name: string): PushCursor | undefined {
    return this.ctx.storage.kv.get(`push-cursor:${name}`) as PushCursor | undefined;
  }
  #putPushCursor(name: string, cursor: PushCursor): void {
    this.ctx.storage.kv.put(`push-cursor:${name}`, cursor);
  }

  subscribe(input: {
    name?: string;
    target: string | Expression;
    consumes?: string[];
    onFailingEvent?: "halt" | "skip";
    maxAttempts?: number;
    start?: "beginning" | "now";
  }): { name: string } {
    this.#touch();
    const target = toExpression(input.target);
    if (target[0] !== "itx")
      throw new Error(
        `subscribe: target must be an itx expression (got ${JSON.stringify(target[0])})`,
      );
    if (typeof target[target.length - 1] !== "string")
      throw new Error(
        "subscribe: target must END in a property step — the sender appends the (events, window) call",
      );
    const name = input.name ?? `subscription:${this.#maxAssigned()}`;
    const rows = this.#pushRows().filter((r) => r.name !== name);
    this.ctx.storage.kv.put("push-subscriptions", [
      ...rows,
      {
        name,
        target,
        consumes: input.consumes,
        onFailingEvent: input.onFailingEvent ?? "halt",
        ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
      },
    ]);
    if (!this.#pushCursor(name))
      this.#putPushCursor(name, {
        confirmedOffset: input.start === "beginning" ? 0 : this.#maxAssigned(),
        attempt: 0,
        skipsSinceSuccess: 0,
      });
    this.#drivePushRows();
    return { name };
  }

  unsubscribe(input: { name: string }): { ok: true } {
    this.ctx.storage.kv.put(
      "push-subscriptions",
      this.#pushRows().filter((r) => r.name !== input.name),
    );
    this.ctx.storage.kv.delete(`push-cursor:${input.name}`);
    return { ok: true };
  }

  /** Recovery from HALT (and the operator's cursor seek): clear the failure state, optionally
   *  move the cursor, kick the pump. */
  resumeSubscription(input: { name: string; afterOffset?: number }): { ok: true } {
    const cursor = this.#pushCursor(input.name);
    if (!cursor) throw new Error(`no push subscription "${input.name}"`);
    this.#putPushCursor(input.name, {
      confirmedOffset: input.afterOffset ?? cursor.confirmedOffset,
      attempt: 0,
      skipsSinceSuccess: 0,
    });
    this.#drivePushRows();
    return { ok: true };
  }

  #drivePushRows(): void {
    for (const row of this.#pushRows())
      void this.#pumpPush(row).catch((e) => console.error(`push "${row.name}" pump failed`, e));
  }

  /** One in-flight delivery per row; loop until caught up. Never called from the commit path
   *  with an await — the commit never blocks on a subscriber. */
  async #pumpPush(row: PushRow): Promise<void> {
    if (this.#pushInFlight.has(row.name)) return;
    this.#pushInFlight.add(row.name);
    try {
      for (;;) {
        const cursor = this.#pushCursor(row.name);
        if (!cursor || cursor.halted) return;
        if (cursor.nextAttemptAtMs && Date.now() < cursor.nextAttemptAtMs) {
          void this.#armAlarmNoLaterThan(cursor.nextAttemptAtMs).catch(() => {});
          return;
        }
        const page = this.read(cursor.confirmedOffset, cursor.pinned ? 1 : 100);
        if (page.scannedThroughOffset <= cursor.confirmedOffset) return; // caught up
        const window = {
          scannedAfterOffset: cursor.confirmedOffset,
          scannedThroughOffset: page.scannedThroughOffset,
        };
        const events = row.consumes
          ? page.events.filter((e) => row.consumes!.includes(e.type))
          : page.events;
        if (events.length === 0) {
          // everything in the window was filtered — confirm through it, no call
          this.#putPushCursor(row.name, {
            ...cursor,
            confirmedOffset: window.scannedThroughOffset,
          });
          continue;
        }
        try {
          const last = row.target[row.target.length - 1] as string;
          const call = [...row.target.slice(0, -1), [last, events, window]] as Expression;
          await Promise.race([
            this.invoke(call), // the awaited call resolving IS the ack
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error(`push "${row.name}": delivery timed out after 20s`)),
                20_000,
              ),
            ),
          ]);
          // A clean delivery resets the WHOLE ladder — including the skip counter, so
          // "3 consecutive skips" really means consecutive.
          this.#putPushCursor(row.name, {
            confirmedOffset: window.scannedThroughOffset,
            attempt: 0,
            skipsSinceSuccess: 0,
          });
        } catch (error) {
          await this.#onPushFailure(row, cursor, events, error);
          return;
        }
      }
    } finally {
      this.#pushInFlight.delete(row.name);
    }
  }

  /** ONE ladder, then ONE policy decision — never interleaved. Every failure retries with
   *  backoff (pinned to a single event after the first, so a poison event is isolated from its
   *  batch); only when the 15 attempts are EXHAUSTED does `onFailingEvent` speak: "halt" stops
   *  the subscription; "skip" drops exactly that one event (with an audit fact) and moves on —
   *  and three consecutive skips (no clean delivery between) still halt. A target outage and a
   *  poison event therefore ride the same, predictable ladder. */
  async #onPushFailure(
    row: PushRow,
    cursor: PushCursor,
    events: StreamEvent[],
    error: unknown,
  ): Promise<void> {
    const attempt = cursor.attempt + 1;
    const message = error instanceof Error ? error.message : String(error);
    if (attempt < (row.maxAttempts ?? 15)) {
      const backoff = Math.min(1000 * 2 ** (attempt - 1), 1_800_000);
      const jittered = Math.round(backoff * (0.8 + Math.random() * 0.4));
      this.#putPushCursor(row.name, {
        ...cursor,
        attempt,
        pinned: true, // isolate-or-progress: every retry runs with batch size 1
        nextAttemptAtMs: Date.now() + jittered,
      });
      void this.#armAlarmNoLaterThan(Date.now() + jittered).catch(() => {});
      return;
    }
    // Retries exhausted — now, and only now, consult the policy.
    if (row.onFailingEvent === "skip" && events.length === 1) {
      const skips = cursor.skipsSinceSuccess + 1;
      if (skips >= 3) return this.#haltPush(row, `3 consecutive skips (last error: ${message})`);
      await this.append({
        type: "events.iterate.com/stream/subscription-event-skipped",
        payload: { name: row.name, offset: events[0].offset, error: message },
      });
      this.#putPushCursor(row.name, {
        confirmedOffset: events[0].offset,
        attempt: 0,
        skipsSinceSuccess: skips,
      });
      void this.#armAlarmNoLaterThan(Date.now()).catch(() => {}); // resume past the skip
      return;
    }
    return this.#haltPush(row, `${attempt} delivery attempts failed (last: ${message})`);
  }

  async #haltPush(row: PushRow, reason: string): Promise<void> {
    const cursor = this.#pushCursor(row.name);
    if (cursor)
      this.#putPushCursor(row.name, {
        confirmedOffset: cursor.confirmedOffset,
        attempt: 0,
        skipsSinceSuccess: cursor.skipsSinceSuccess,
        halted: { reason },
      });
    await this.append({
      type: "events.iterate.com/stream/subscription-delivery-halted",
      payload: { name: row.name, reason },
    });
  }

  // ── facet-hosted processors (built-ins via processor-facet.ts; userspace via the LOADER) ──

  #facetEntries(): FacetProcessorEntry[] {
    return (this.ctx.storage.kv.get("facet-processors") as FacetProcessorEntry[] | undefined) ?? [];
  }

  /** Materialize (or reuse) the facet hosting `slug`. A stored `ref` means USERSPACE: the
   *  user's modules ride the Worker Loader beside the injected SDK (`processor.js` — base class
   *  + contract helper + zod) and the generic runner DO (`runner.js`); the user exports
   *  `class X extends StreamProcessor` and never writes a DurableObject. Both facet kinds speak
   *  the same duck contract: configure / processEventBatch / snapshot / waitUntilProcessed.
   *  NEVER retain the returned handle (#6800: re-`get` per burst; the quiesce alarm aborts). */
  async #facet(slug: string): Promise<FacetProcessorHandle> {
    this.#noteActivity();
    const ref = this.#facetEntries().find((e) => e.slug === slug)?.ref;
    if (!ref) {
      const exports = (this.ctx as unknown as { exports: Record<string, unknown> }).exports;
      return this.ctx.facets.get(`proc:${slug}`, () => ({
        class: exports.ProcessorFacet as DurableObjectClass,
      })) as unknown as FacetProcessorHandle;
    }
    const userModules = (await this.invoke(ref.source)) as Record<string, string>;
    const version = hashSource(JSON.stringify(userModules));
    const v = this.env.CF_VERSION_METADATA?.id ?? "unversioned";
    const worker = confinedWorker(
      this.env.LOADER,
      // Deploy id in the key (the stale-isolate/DataCloneError family): see the stateful runner.
      `procfacet:${v}:${this.#doName}:${slug}:${version}`,
      "runner.js",
      {
        ...userModules,
        "processor.js": PROCESSOR_SDK_MODULE,
        "runner.js": PROCESSOR_RUNNER_MODULE,
      },
      this.env.CONTEXT.getByName(this.#doName),
    );
    const klass = worker.getDurableObjectClass("ProcessorFacetRunner");
    if (!klass) throw new Error(`userspace processor "${slug}": runner class missing`);
    // Abort + recreate the facet on a source change, KEEPING its storage — the stateful runner's
    // version-marker pattern, keyed per slug.
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
   *  + which `export` is the StreamProcessor subclass — stored durably so every incarnation
   *  rebuilds the same facet. */
  async enableProcessor(
    slug: string,
    ref?: { source: string | Expression; export: string },
  ): Promise<{ ok: true }> {
    this.#touch();
    const entry: FacetProcessorEntry = ref
      ? { slug, ref: { source: toExpression(ref.source), export: ref.export } }
      : { slug };
    const others = this.#facetEntries().filter((e) => e.slug !== slug);
    this.ctx.storage.kv.put("facet-processors", [...others, entry]);
    await (await this.#facet(slug)).configure(this.#identityFor(slug, ref?.export));
    return { ok: true };
  }

  /** THE generic facet door: resolve the facet LOCALLY (facet stubs are non-transferable — the
   *  walk happens where the stub lives), walk the dotted path with the exposure guard, apply
   *  the terminal. `roots.facets` (and via one seed, `itx.facets`) rides this to reach ANY
   *  method a facet's durable object exposes — a facet hosts an object; processor is a role. */
  async facetInvoke(slug: string, path: string[], args: unknown[]): Promise<unknown> {
    if (path.length === 0) throw new Error(`facet "${slug}": name a method`);
    if (slug !== ICTX_SLUG && !this.#facetEntries().some((e) => e.slug === slug))
      throw new Error(`no facet "${slug}" enabled`);
    const facet = (await this.#facet(slug)) as unknown as object;
    let receiver: unknown = facet;
    for (let i = 0; i < path.length - 1; i++) {
      receiver = await stepGet(receiver as object, path[i]);
      if (receiver == null)
        throw new Error(
          `facet "${slug}": "${path.join(".")}" hit ${String(receiver)} at "${path[i]}"`,
        );
    }
    const handler = stepGet(receiver as object, path[path.length - 1]);
    if (typeof handler !== "function")
      throw new Error(`facet "${slug}" has no method "${path.join(".")}"`);
    return await Reflect.apply(handler, receiver, args);
  }

  #identityFor(slug: string, exportName?: string): FacetIdentity {
    return {
      parentName: this.#doName,
      projectId: this.#name.projectId,
      path: this.#name.path,
      slug,
      ...(exportName ? { export: exportName } : {}),
    };
  }

  /** THE capability host — the iterate-context facet, lazily enabled on first use like any other
   *  facet processor (so every commit drives it too); the durable marker keeps the enable to
   *  once, not once per call. */
  async #ictx(): Promise<ProcessorFacet> {
    if (!this.ctx.storage.kv.get("ictx:enabled")) {
      await this.enableProcessor(ICTX_SLUG);
      this.ctx.storage.kv.put("ictx:enabled", true);
    }
    return (await this.#facet(ICTX_SLUG)) as unknown as ProcessorFacet;
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
    // Read-only on purpose — probing /state must never be the write that mints storage.
    if (url.pathname === "/state")
      return Response.json({
        incarnation: this.#storageReady
          ? this.incarnation
          : ((this.ctx.storage.kv.get("incarnation") as number | undefined) ?? 0),
        facetProcessors: this.#facetEntries().map((e) => e.slug),
        pushSubscriptions: this.#pushRows().map((r) => {
          const c = this.#pushCursor(r.name);
          return {
            name: r.name,
            confirmedOffset: c?.confirmedOffset ?? 0,
            attempt: c?.attempt ?? 0,
            skipsSinceSuccess: c?.skipsSinceSuccess ?? 0,
            ...(c?.halted ? { halted: c.halted.reason } : {}),
          };
        }),
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
    this.#touch(); // a park is real project use (durable socket attachments follow)
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
    this.#touch(); // a park is real project use (durable socket attachments follow)
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
      openedAt: new Date().toISOString(),
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
