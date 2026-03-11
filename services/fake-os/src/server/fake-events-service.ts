import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db } from "./db/index.ts";
import * as schema from "./db/schema.ts";

type DeploymentEventSource = {
  snapshot(): { state: string };
  events(params?: { signal?: AbortSignal; logTail?: number }): AsyncIterable<DeploymentStreamEvent>;
};

type DeploymentStreamEvent =
  | {
      type: "https://events.iterate.com/deployment/created";
      payload: { baseUrl: string; locator: unknown };
    }
  | {
      type: "https://events.iterate.com/deployment/started";
      payload: { detail: string };
    }
  | {
      type: "https://events.iterate.com/deployment/stopped";
      payload: { detail: string };
    }
  | {
      type: "https://events.iterate.com/deployment/logged";
      payload: { line: string };
    }
  | {
      type: "https://events.iterate.com/deployment/errored";
      payload: { message: string };
    }
  | {
      type: "https://events.iterate.com/deployment/destroyed";
      payload: Record<string, never>;
    };

type PersistedDeploymentStreamEvent = DeploymentStreamEvent & {
  id: number;
  path: string;
  createdAt: Date | null;
};

class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T) {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close() {
    this.closed = true;
    for (const resolver of this.resolvers.splice(0)) {
      resolver({ value: undefined, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return { value: this.items.shift()!, done: false };
    }
    if (this.closed) {
      return { value: undefined, done: true };
    }
    return await new Promise<IteratorResult<T>>((resolve) => {
      this.resolvers.push(resolve);
    });
  }
}

/**
 * fake-events-service
 *
 * This is a short-term adapter that makes fake-os behave a bit more like the
 * eventual event bus architecture.
 *
 * The long-term plan is that deployment lifecycle facts and log lines will be
 * appended to the real events service, so they can be observed from outside the
 * fake-os process, including from the OS worker / control plane.
 *
 * We are NOT doing that yet here. Instead, this module:
 *
 * 1. Persists deployment events into a local sqlite `events` table.
 * 2. Keeps one background subscription per connected deployment.
 * 3. Replays persisted history first, then follows live appends.
 *
 * That means the frontend can already think in terms of "a stream at
 * `/deployment/:slug`" even though the backing implementation is still a local
 * sqlite table plus in-process fanout.
 *
 * Important limitations of this temporary design:
 *
 * - History only exists from the point fake-os started observing that
 *   deployment. This is NOT yet the durable global event bus.
 * - On restart, we reconnect to the provider and subscribe again. Because the
 *   provider-level logs API is still line-oriented and tail-based, we may
 *   re-ingest a small amount of recent history when re-attaching.
 * - The table stores deployment events, not raw provider cursors or tokens.
 *
 * Despite those limits, the frontend-facing shape becomes much closer to the
 * future event-bus shape: "there is a stream at `/deployment/:slug`, and you
 * subscribe to that stream".
 */
export class FakeEventsService {
  private readonly subscriptions = new Map<
    string,
    {
      controller: AbortController;
      startedAt: Date;
    }
  >();

  private readonly liveSubscribers = new Map<
    string,
    Set<AsyncQueue<PersistedDeploymentStreamEvent>>
  >();

  streamPathForDeployment(slug: string) {
    return `/deployment/${slug}`;
  }

  /**
   * Ensures a single background consumer is attached to a connected deployment.
   *
   * We intentionally subscribe as soon as fake-os connects to a deployment, so
   * logs and lifecycle changes immediately start flowing into the local event
   * stream table. The UI does not subscribe to the deployment object directly;
   * it subscribes to this persisted stream instead.
   */
  async ensureSubscribed(params: { slug: string; deployment: DeploymentEventSource }) {
    if (this.subscriptions.has(params.slug)) return;

    const snapshot = params.deployment.snapshot();
    if (snapshot.state !== "connected") return;

    const controller = new AbortController();
    this.subscriptions.set(params.slug, {
      controller,
      startedAt: new Date(),
    });

    void this.consumeDeploymentEvents({
      slug: params.slug,
      deployment: params.deployment,
      signal: controller.signal,
    }).finally(() => {
      this.subscriptions.delete(params.slug);
    });
  }

  /**
   * Streams a deployment path exactly the way the frontend wants to consume it:
   * full sqlite-backed history first, then live events appended by the
   * background deployment consumer.
   */
  async *streamDeployment(params: {
    slug: string;
    signal?: AbortSignal;
  }): AsyncIterable<DeploymentStreamEvent> {
    const path = this.streamPathForDeployment(params.slug);
    const queue = new AsyncQueue<PersistedDeploymentStreamEvent>();
    let highWatermark = 0;

    this.addLiveSubscriber(path, queue);

    try {
      const latestRow = db
        .select({ id: schema.eventsTable.id })
        .from(schema.eventsTable)
        .where(eq(schema.eventsTable.streamPath, path))
        .orderBy(sql`${schema.eventsTable.id} desc`)
        .limit(1)
        .get();
      highWatermark = latestRow?.id ?? 0;

      const history = db
        .select()
        .from(schema.eventsTable)
        .where(
          and(eq(schema.eventsTable.streamPath, path), lte(schema.eventsTable.id, highWatermark)),
        )
        .orderBy(asc(schema.eventsTable.id))
        .all();

      for (const row of history) {
        if (params.signal?.aborted) return;
        yield this.rowToEvent(row);
      }

      while (!params.signal?.aborted) {
        const next = await queue.next();
        if (next.done) return;
        if (next.value.id <= highWatermark) continue;
        yield next.value;
      }
    } finally {
      this.removeLiveSubscriber(path, queue);
      queue.close();
    }
  }

  /**
   * Stops the background provider consumer for a deployment.
   *
   * We use this after deletion and also automatically stop when a destroyed
   * event is observed.
   */
  stopSubscription(slug: string) {
    const existing = this.subscriptions.get(slug);
    existing?.controller.abort();
    this.subscriptions.delete(slug);
  }

  private async consumeDeploymentEvents(params: {
    slug: string;
    deployment: DeploymentEventSource;
    signal: AbortSignal;
  }) {
    const path = this.streamPathForDeployment(params.slug);

    /**
     * This is the "short-term hack" part:
     *
     * We ask the deployment object itself to emit logs + lifecycle facts, then
     * we materialize those facts into sqlite. Eventually, the deployment should
     * append directly to the real event bus instead, and fake-os should consume
     * that bus.
     *
     * `logTail` is intentionally only a bootstrap aid for now. On the first
     * attachment we ask for some recent history so a restarted fake-os is not
     * completely blind. Once the local stream already has persisted rows, we
     * request `logTail: 0` to reduce duplicate backfill.
     */
    const existingEventCount =
      db
        .select({ count: sql<number>`count(*)` })
        .from(schema.eventsTable)
        .where(eq(schema.eventsTable.streamPath, path))
        .get()?.count ?? 0;

    const initialLogTail = existingEventCount > 0 ? 0 : 200;

    for await (const event of params.deployment.events({
      signal: params.signal,
      logTail: initialLogTail,
    })) {
      const persisted = this.append({
        path,
        event,
      });

      if (event.type === "https://events.iterate.com/deployment/destroyed") {
        this.stopSubscription(params.slug);
        return;
      }

      if (params.signal.aborted) return;

      // `append()` already fans out to live subscribers. `persisted` is unused
      // here on purpose; we keep the side effect centralized in one place.
      void persisted;
    }
  }

  private append(params: {
    path: string;
    event: DeploymentStreamEvent;
  }): PersistedDeploymentStreamEvent {
    const row = db
      .insert(schema.eventsTable)
      .values({
        streamPath: params.path,
        eventType: params.event.type,
        payload: params.event.payload,
      })
      .returning()
      .get();

    const persisted = this.rowToEvent(row);
    const subscribers = this.liveSubscribers.get(params.path);
    for (const subscriber of subscribers ?? []) {
      subscriber.push(persisted);
    }
    return persisted;
  }

  private rowToEvent(row: typeof schema.eventsTable.$inferSelect): PersistedDeploymentStreamEvent {
    return {
      type: row.eventType as DeploymentStreamEvent["type"],
      payload: row.payload as DeploymentStreamEvent["payload"],
      id: row.id,
      path: row.streamPath,
      createdAt: row.createdAt,
    } as PersistedDeploymentStreamEvent;
  }

  private addLiveSubscriber(path: string, queue: AsyncQueue<PersistedDeploymentStreamEvent>) {
    const existing =
      this.liveSubscribers.get(path) ?? new Set<AsyncQueue<PersistedDeploymentStreamEvent>>();
    existing.add(queue);
    this.liveSubscribers.set(path, existing);
  }

  private removeLiveSubscriber(path: string, queue: AsyncQueue<PersistedDeploymentStreamEvent>) {
    const existing = this.liveSubscribers.get(path);
    if (!existing) return;
    existing.delete(queue);
    if (existing.size === 0) {
      this.liveSubscribers.delete(path);
    }
  }
}

export const fakeEventsService = new FakeEventsService();
