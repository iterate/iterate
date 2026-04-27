import {
  ChildStreamCreatedEvent,
  EventInput,
  ProjectSlug,
  StreamPath,
  StreamSocketFrame,
} from "@iterate-com/events-contract";
import { parseAppConfig } from "@iterate-com/shared/apps/config";
import { Agent, type Connection, type WSMessage } from "agents";
import { z } from "zod";
import { AppConfig } from "~/app.ts";
import { createEventsOrpcClient } from "~/lib/events-orpc-client.ts";
import {
  buildAgentWebSocketCallbackUrl,
  ITERATE_AGENT_CLASS,
  ITERATE_AGENT_SUBSCRIPTION_SLUG,
  streamPathToAgentInstance,
} from "~/lib/iterate-agent-addressing.ts";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";

/** Query parameter on this DO's callback URL that carries the public origin
 *  which subsequent `iterate-agent` subscriptions should point back at.
 *
 *  Set by `installProcessor` when it configures the subscription on
 *  `appConfig.streamPathPrefix`. Read here on every message via
 *  `Connection.uri` (partyserver persists the upgrade URL across hibernation).
 */
export const AUTO_SUBSCRIBER_PUBLIC_BASE_URL_QUERY_PARAM = "publicBaseUrl";

/** Durable Object instance name under `/agents/child-stream-auto-subscriber/<instance>`. */
export const AUTO_SUBSCRIBER_INSTANCE = "default";

/**
 * KV key prefix for "default events to apply when a new child stream is born
 * under base path X". Stored as a JSON-serialised `EventInput[]` under
 * `defaults:<basePath>`. Looked up on every `child-stream-created` event by
 * walking up the new stream's path (longest match wins). Set/cleared via the
 * `configureBasePathDefaults` / `clearBasePathDefaults` oRPC procedures.
 */
const DEFAULTS_KV_PREFIX = "defaults:";

/**
 * KV key prefix for "we've seen this child stream and wired up an
 * iterate-agent for it". Stored as `{ discoveredAt: number }` under
 * `agent:<streamPath>`. The `listAgents` RPC reads these entries to populate
 * the sidebar. Idempotent on re-discovery: subsequent `child-stream-created`
 * events for the same path just refresh `discoveredAt` (cheap, and means a
 * re-subscribe shows up at the top of the sidebar).
 */
const AGENTS_KV_PREFIX = "agent:";

const DefaultEventsList = z.array(EventInput);

const DiscoveredAgentRecord = z.object({
  discoveredAt: z.number().int().nonnegative(),
});

/**
 * Loose `EventInput` shape used on this DO's RPC method boundary. See
 * `setBasePathDefaults` below for why we don't use the strict
 * `EventInput` union type here.
 */
type WireEventInput = { type: string; payload: object };

/** Wire shape for `listAgents` results — see `WireEventInput` for the rationale. */
type WireDiscoveredAgent = { streamPath: string; discoveredAt: number };

/**
 * Watches for `child-stream-created` events on the parent stream
 * (`AppConfig.streamPathPrefix`, by default `/agents`) and, for every newly
 * appearing descendant stream:
 *   1. Auto-subscribes the `IterateAgent` processor (via WebSocket) so the
 *      durable object connects and starts processing events.
 *   2. Appends the configured "default events" (model, system prompt,
 *      arbitrary advanced events…) for the longest matching base path stored
 *      in this DO's KV. Used to make `/agents/<random>` Just Work without the
 *      caller having to repeat the same setup events every time.
 *
 * Every child stream bubbles `child-stream-created` up through every ancestor,
 * so subscribing this single processor to a single ancestor (the prefix) is
 * enough to see every descendant.
 *
 * The callback URL it posts when subscribing `iterate-agent` to the child
 * stream is derived from the `publicBaseUrl` that `installProcessor` encoded
 * into this DO's own WebSocket upgrade URL as a query parameter. Using
 * `connection.uri` as the source of truth keeps the control plane
 * (`installProcessor`) coupled to the DO only through the subscription
 * `callbackUrl` that Events stores — nothing else.
 */
export class ChildStreamAutoSubscriber extends Agent<CloudflareEnv> {
  async onMessage(connection: Connection, message: WSMessage) {
    const log = this.#log.bind(this);
    const text = websocketMessageToString(message);
    if (text == null) {
      log("onMessage.skip", { reason: "binary-or-unknown-message-type" });
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      log("onMessage.skip", { reason: "invalid-json", len: text.length });
      return;
    }

    const frame = StreamSocketFrame.safeParse(json);
    if (!frame.success || frame.data.type !== "event") {
      log("onMessage.skip", {
        reason: frame.success ? "non-event-frame" : "not-stream-socket-frame",
      });
      return;
    }

    const childCreated = ChildStreamCreatedEvent.safeParse(frame.data.event);
    if (!childCreated.success) {
      log("onMessage.skip", {
        reason: "not-child-stream-created",
        eventType: (frame.data.event as { type?: string }).type,
      });
      return;
    }

    const publicBaseUrl = extractPublicBaseUrlFromConnection(connection);
    if (publicBaseUrl == null) {
      this.#logError("onMessage.missingPublicBaseUrl", {
        connectionUri: connection.uri ?? null,
      });
      return;
    }

    const appConfig = parseAppConfig(AppConfig, this.env.APP_CONFIG);
    const childPath = childCreated.data.payload.childPath;
    const projectSlug = ProjectSlug.parse(appConfig.eventsProjectSlug);
    const agentInstance = streamPathToAgentInstance(childPath);
    const callbackUrl = buildAgentWebSocketCallbackUrl({
      publicOrigin: publicBaseUrl,
      agentClass: ITERATE_AGENT_CLASS,
      agentInstance,
    });

    const eventsClient = createEventsOrpcClient({
      baseUrl: appConfig.eventsBaseUrl,
      projectSlug,
    });

    // Subscribe iterate-agent FIRST so the DO is connected by the time the
    // default events land — every default we append below is a normal
    // websocket frame the agent will see live, no replay round-trip required.
    try {
      await eventsClient.append({
        path: childPath,
        event: {
          type: "https://events.iterate.com/events/stream/subscription/configured",
          payload: {
            slug: ITERATE_AGENT_SUBSCRIPTION_SLUG,
            type: "websocket",
            callbackUrl,
          },
        },
      });
      log("onMessage.subscribed", { childPath, agentInstance, callbackUrl });
    } catch (error) {
      this.#logError("onMessage.subscribeFailed", {
        childPath,
        agentInstance,
        callbackUrl,
        error: stringifyError(error),
      });
      return;
    }

    // Record the discovery so the dashboard's sidebar can list every agent
    // the auto-subscriber has wired up. Cheap idempotent overwrite — same
    // streamPath just bumps discoveredAt.
    this.ctx.storage.kv.put(`${AGENTS_KV_PREFIX}${childPath}`, {
      discoveredAt: Date.now(),
    });

    const matched = this.#lookupDefaultsForChildPath(childPath);
    if (matched == null) {
      log("onMessage.noDefaults", { childPath });
      return;
    }

    log("onMessage.applyingDefaults", {
      childPath,
      basePath: matched.basePath,
      count: matched.events.length,
    });

    // Sequential append: order matters because the reducer is order-sensitive
    // (e.g. last `llm-config-updated` wins). We can't batch through the events
    // contract today — keep this simple and best-effort. A failure on one
    // event is logged and we continue with the rest so a partial config is
    // still useful.
    for (const event of matched.events) {
      try {
        await eventsClient.append({ path: childPath, event });
      } catch (error) {
        this.#logError("onMessage.applyDefaultEventFailed", {
          childPath,
          basePath: matched.basePath,
          eventType: (event as { type?: string }).type,
          error: stringifyError(error),
        });
      }
    }
  }

  async onRequest(_request: Request): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }

  /**
   * Replace the stored default events for a base path. Idempotent: writing the
   * same `basePath` twice just overwrites; writing a strict-superset path
   * (e.g. `/agents/team-x` while `/agents` already has defaults) creates a
   * second, more-specific entry that wins for descendants of `/agents/team-x`.
   *
   * Called by the `configureBasePathDefaults` oRPC handler.
   *
   * Method signatures use the loose `WireEventInput` shape rather than
   * `EventInput[]` from `events-contract` because workerd's Durable Object RPC
   * codegen can't prove the strict event-discriminated-union is recursively
   * JSON-serializable and the return type collapses to `never`. We parse
   * strictly inside the DO and at append time, so loose typing on the stub
   * boundary is safe.
   */
  async setBasePathDefaults(args: {
    basePath: string;
    events: ReadonlyArray<WireEventInput>;
  }): Promise<{ basePath: string; eventCount: number }> {
    const basePath = StreamPath.parse(args.basePath);
    const events = DefaultEventsList.parse(args.events);
    this.ctx.storage.kv.put(`${DEFAULTS_KV_PREFIX}${basePath}`, events);
    this.#log("setBasePathDefaults", { basePath, count: events.length });
    return { basePath, eventCount: events.length };
  }

  /**
   * Drop the stored default events for a base path. No-op when there's no
   * matching entry — callers don't need to check first.
   *
   * Called by the `clearBasePathDefaults` oRPC handler.
   */
  async clearBasePathDefaults(args: { basePath: string }): Promise<{ existed: boolean }> {
    const basePath = StreamPath.parse(args.basePath);
    const existed =
      this.ctx.storage.kv.get<unknown>(`${DEFAULTS_KV_PREFIX}${basePath}`) !== undefined;
    if (existed) {
      this.ctx.storage.kv.delete(`${DEFAULTS_KV_PREFIX}${basePath}`);
    }
    this.#log("clearBasePathDefaults", { basePath, existed });
    return { existed };
  }

  /**
   * Return every base path that currently has a default-events entry, in
   * deterministic (alphabetical) order. Events are returned in the loose
   * `WireEventInput` shape (see `setBasePathDefaults`'s comment for why);
   * callers re-parse strictly if they need the discriminated-union type.
   */
  async listBasePathDefaults(): Promise<Array<{ basePath: string; events: WireEventInput[] }>> {
    const results: Array<{ basePath: string; events: WireEventInput[] }> = [];
    for (const [key, value] of this.ctx.storage.kv.list<unknown>()) {
      if (!key.startsWith(DEFAULTS_KV_PREFIX)) continue;
      const basePath = key.slice(DEFAULTS_KV_PREFIX.length);
      const events = DefaultEventsList.parse(value);
      results.push({
        basePath,
        events: events.map((event) => ({
          type: event.type,
          payload: event.payload,
        })),
      });
    }
    return results.sort((a, b) => a.basePath.localeCompare(b.basePath));
  }

  /**
   * Return every agent (= child stream) the auto-subscriber has discovered
   * and wired up, optionally filtered by a path prefix. Sorted by
   * `discoveredAt` descending so the most recent agents show up first
   * in the sidebar.
   *
   * `prefix` is matched on the stored `streamPath` directly, so callers can
   * scope the list to a specific preset/base path (e.g. `/agents/joker`).
   * Empty / undefined prefix returns all agents.
   */
  async listAgents(args: { prefix?: string } = {}): Promise<WireDiscoveredAgent[]> {
    const prefix = args.prefix?.trim() ?? "";
    const out: WireDiscoveredAgent[] = [];
    for (const [key, value] of this.ctx.storage.kv.list<unknown>()) {
      if (!key.startsWith(AGENTS_KV_PREFIX)) continue;
      const streamPath = key.slice(AGENTS_KV_PREFIX.length);
      if (prefix.length > 0 && !streamPath.startsWith(prefix)) continue;
      const parsed = DiscoveredAgentRecord.safeParse(value);
      if (!parsed.success) {
        this.#logError("listAgents.invalidStored", {
          streamPath,
          error: parsed.error.message,
        });
        continue;
      }
      out.push({ streamPath, discoveredAt: parsed.data.discoveredAt });
    }
    return out.sort((a, b) => b.discoveredAt - a.discoveredAt);
  }

  /**
   * Walk up `childPath`'s ancestors and return the first (= deepest) base
   * path that has stored defaults. `null` when nothing matches.
   *
   * E.g. for `childPath="/agents/team-x/foo"` we probe in order:
   *   `/agents/team-x/foo`, `/agents/team-x`, `/agents`, `/`
   * and return the first one that's set in KV. The childPath itself is also
   * a candidate so a single static stream (`/agents/standup`) can have its
   * own dedicated defaults.
   */
  #lookupDefaultsForChildPath(
    childPath: string,
  ): { basePath: string; events: EventInput[] } | null {
    for (const candidate of ancestorPaths(childPath)) {
      const value = this.ctx.storage.kv.get<unknown>(`${DEFAULTS_KV_PREFIX}${candidate}`);
      if (value === undefined) continue;
      const parsed = DefaultEventsList.safeParse(value);
      if (!parsed.success) {
        this.#logError("lookupDefaults.invalidStored", {
          basePath: candidate,
          error: parsed.error.message,
        });
        continue;
      }
      return { basePath: candidate, events: parsed.data };
    }
    return null;
  }

  #log(event: string, fields: Record<string, unknown>) {
    console.info(
      JSON.stringify({ at: `ChildStreamAutoSubscriber.${event}`, name: this.name, ...fields }),
    );
  }

  #logError(event: string, fields: Record<string, unknown>) {
    console.error(
      JSON.stringify({ at: `ChildStreamAutoSubscriber.${event}`, name: this.name, ...fields }),
    );
  }
}

/**
 * Yield `path` and each of its ancestors, deepest first, ending at `/`.
 * Used to look up the most-specific defaults entry for a new child stream.
 */
function ancestorPaths(path: string): string[] {
  const segments = path.split("/").filter((s) => s.length > 0);
  const out: string[] = [];
  for (let i = segments.length; i > 0; i--) {
    out.push(`/${segments.slice(0, i).join("/")}`);
  }
  out.push("/");
  return out;
}

function extractPublicBaseUrlFromConnection(connection: Connection): string | null {
  const uri = connection.uri;
  if (uri == null) {
    return null;
  }
  try {
    const url = new URL(uri);
    const raw = url.searchParams.get(AUTO_SUBSCRIBER_PUBLIC_BASE_URL_QUERY_PARAM);
    if (raw == null || raw.length === 0) {
      return null;
    }
    const parsed = z.url().safeParse(raw);
    if (!parsed.success) {
      return null;
    }
    return new URL(parsed.data).origin;
  } catch {
    return null;
  }
}

function websocketMessageToString(message: WSMessage): string | null {
  if (typeof message === "string") return message;
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(message);
  if (ArrayBuffer.isView(message)) {
    const view = message as ArrayBufferView;
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  return null;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
