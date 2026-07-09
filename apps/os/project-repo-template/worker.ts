import { WebClient } from "@slack/web-api";
import { StreamProcessor, defineProcessorContract, z } from "iterate/sdk";
import {
  IterateProjectWorker,
  type Agent,
  type Ai,
  type DynamicWorkerRef,
  type StreamEvent,
  type StreamEventBatch,
} from "./sdk.ts";
import { waitroseClient } from "./integrations/waitrose/client.ts";

/** Configuration for the `slack` getter below. Commit changes here to point
 * the SDK at your workspace: set `token` to a bot token, and leave
 * `slackApiUrl` null for the real Slack API (override it only for mocks or
 * staging proxies). */
const slackConfig: {
  slackApiUrl: string | null;
  token: string | null;
} = {
  slackApiUrl: null,
  token: null,
};

// The root project worker is a small ROUTER over the project's apps. Each app
// is its own repo-backed dynamic worker built from this repo (multi-file
// TypeScript — the build pipeline bundles the masked file snapshot); ingress
// selects one via the trusted x-iterate-app header (hosts like
// hello--<slug>.<base> or <app>.<custom-hostname>). Requests with no app
// selected get the static homepage below.
const APPS = {
  hello: {
    type: "stateless",
    path: "/",
    source: {
      files: { type: "repo", repoPath: "/", include: ["apps/hello/**"] },
      options: { entryPoint: "apps/hello/worker.ts" },
    },
  },
  counter: {
    type: "stateful",
    path: "/",
    className: "CounterApp",
    durableWorkerKey: "app-counter",
    source: {
      files: { type: "repo", repoPath: "/", include: ["apps/counter/**"] },
      options: { entryPoint: "apps/counter/worker.ts" },
    },
  },
  websocket: {
    type: "stateful",
    path: "/",
    className: "WebsocketEchoApp",
    durableWorkerKey: "app-websocket",
    source: {
      files: { type: "repo", repoPath: "/", include: ["apps/websocket/**"] },
      options: { entryPoint: "apps/websocket/worker.ts" },
    },
  },
} satisfies Record<string, DynamicWorkerRef>;

// ---------------------------------------------------------------------------
// Compaction: userspace history management for this project's agents.
//
// The platform reports normalized token usage after every LLM request
// (agent/token-usage-reported) and folds agent/history-reset events into the
// model-visible history wholesale. Everything between those two events is
// project policy, and it lives HERE: once a turn's context passes half the
// model's window, summarize the history with itx.ai and reset it to the
// summary. Built on the same StreamProcessor the platform's own processors
// run on (iterate/sdk). Delivery is at-least-once, so every append is
// idempotency-keyed on the triggering report's offset — redelivery is a no-op.
// ---------------------------------------------------------------------------

/** Compact once a request's context passes this fraction of the model window. */
const COMPACTION_TRIGGER_FRACTION = 0.5;

/** Reports this far behind the stream head are backlog replay, not a live
 * turn — compacting from them would describe history that has moved on. */
const COMPACTION_MAX_TRIGGER_LAG_EVENTS = 200;

const COMPACTION_MODEL = "@cf/moonshotai/kimi-k2.7-code";

const COMPACTION_PROMPT =
  "You compress an agent's conversation history. Produce a dense, factual summary " +
  "preserving: the user's goals and open asks, decisions made, key script/tool results, " +
  "and anything the agent promised to do. Write it so the agent can continue as if it " +
  "remembered everything.";

const CompactionProcessorContract = defineProcessorContract({
  slug: "compaction",
  version: "0.1.0",
  description:
    "Summarizes an agent's history into a history-reset once a turn's context passes half the model window.",
  // Stateless on purpose: dedup lives in the idempotency keys, not in a fold.
  stateSchema: z.object({}),
  events: {
    // The platform's agent contract owns the two agent/* schemas; they are
    // declared here with the slice this processor reads/writes so the
    // contract resolves them standalone.
    "events.iterate.com/agent/token-usage-reported": {
      payloadSchema: z.looseObject({
        llmRequestId: z.number(),
        model: z.string(),
        maxContextTokens: z.number(),
        inputTokens: z.number(),
        outputTokens: z.number(),
      }),
    },
    "events.iterate.com/agent/history-reset": {
      payloadSchema: z.object({
        systemPrompt: z.string(),
        history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })),
        reason: z.string().optional(),
      }),
    },
    "events.iterate.com/compaction/compaction-started": {
      description: "History crossed the compaction threshold; a summary is being generated.",
      payloadSchema: z.object({
        triggeringEventOffset: z.number().int().positive(),
        contextTokens: z.number().int().nonnegative(),
        thresholdTokens: z.number().int().positive(),
      }),
    },
    "events.iterate.com/compaction/compaction-completed": {
      description: "The compaction appended history-reset, or failed.",
      payloadSchema: z.object({
        triggeringEventOffset: z.number().int().positive(),
        durationMs: z.number().int().nonnegative(),
        result: z.discriminatedUnion("status", [
          z.object({ status: z.literal("success") }),
          z.object({ status: z.literal("failure"), error: z.object({ message: z.string() }) }),
        ]),
      }),
    },
  },
  consumes: ["events.iterate.com/agent/token-usage-reported"],
  emits: [
    "events.iterate.com/compaction/compaction-started",
    "events.iterate.com/compaction/compaction-completed",
    "events.iterate.com/agent/history-reset",
  ],
});

class CompactionProcessor extends StreamProcessor<
  typeof CompactionProcessorContract,
  {
    /** THIS agent's control surface; its processor fold carries history + system prompt. */
    agent: Agent;
    /** Workers AI, for the summary itself. */
    ai: Ai;
  }
> {
  readonly contract = CompactionProcessorContract;

  protected override processEvent({
    append,
    event,
    runInBackground,
    streamMaxOffset,
  }: Parameters<
    StreamProcessor<typeof CompactionProcessorContract>["processEvent"]
  >[0]): undefined {
    const usage = event.payload;
    const contextTokens = usage.inputTokens + usage.outputTokens;
    const thresholdTokens = Math.floor(usage.maxContextTokens * COMPACTION_TRIGGER_FRACTION);
    if (contextTokens < thresholdTokens) return;
    if (streamMaxOffset - event.offset > COMPACTION_MAX_TRIGGER_LAG_EVENTS) return;
    const triggeringEventOffset = event.offset;

    runInBackground(async () => {
      const startedAt = Date.now();
      await append({
        type: "events.iterate.com/compaction/compaction-started",
        idempotencyKey: `compaction/started@${triggeringEventOffset}`,
        payload: { triggeringEventOffset, contextTokens, thresholdTokens },
      });
      try {
        // Read-your-writes: wait until the agent's fold includes the trigger,
        // then take history + system prompt from its reduced state — no event
        // re-reading, no second fold.
        await this.deps.agent.processor.waitUntilEvent({
          offset: triggeringEventOffset,
          timeoutMs: 30_000,
        });
        const { state } = await this.deps.agent.processor.snapshot();
        const transcript = state.history
          .map((item) => `${item.role}:\n${item.content}`)
          .join("\n\n");
        const raw = await this.deps.ai.run(COMPACTION_MODEL, {
          messages: [
            { role: "system", content: COMPACTION_PROMPT },
            { role: "user", content: transcript },
          ],
        });
        const summary =
          typeof raw === "object" && raw !== null && "response" in raw
            ? String((raw as { response: unknown }).response)
            : JSON.stringify(raw);
        await append(
          {
            type: "events.iterate.com/agent/history-reset",
            idempotencyKey: `compaction/history-reset@${triggeringEventOffset}`,
            payload: {
              systemPrompt: state.systemPrompt,
              history: [
                {
                  role: "user",
                  content: `[Earlier conversation history was compacted. Summary:]\n\n${summary}`,
                },
              ],
              reason: `compaction@${triggeringEventOffset}: ~${contextTokens} tokens > ${thresholdTokens}`,
            },
          },
          {
            type: "events.iterate.com/compaction/compaction-completed",
            idempotencyKey: `compaction/completed@${triggeringEventOffset}`,
            payload: {
              triggeringEventOffset,
              durationMs: Date.now() - startedAt,
              result: { status: "success" },
            },
          },
        );
      } catch (error) {
        await append({
          type: "events.iterate.com/compaction/compaction-completed",
          idempotencyKey: `compaction/completed@${triggeringEventOffset}`,
          payload: {
            triggeringEventOffset,
            durationMs: Date.now() - startedAt,
            result: {
              status: "failure",
              error: { message: error instanceof Error ? error.message : String(error) },
            },
          },
        });
      }
    });
  }
}

export default class ProjectWorker extends IterateProjectWorker {
  async fetch(req: Request): Promise<Response> {
    const appSlug = req.headers.get("x-iterate-app");
    if (appSlug) {
      const ref = Object.hasOwn(APPS, appSlug) ? APPS[appSlug as keyof typeof APPS] : undefined;
      if (!ref) return new Response(`unknown app: ${appSlug}`, { status: 404 });

      // Every app request — pages, APIs, streaming bodies, WebSocket upgrades
      // — dispatches over the platform's fetch-native worker lane:
      // `env.ITX.fetch` with the target ref in the x-iterate-worker-dispatch
      // header (JSON { ref, buildBudgetMs? } — same ref shape as
      // project.workers.get). Real fetch hops are what let a 101 upgrade
      // tunnel through; an `app.fetch(req)` RPC method call cannot carry one.
      // A cold build answers a 503 building page that refreshes itself
      // (marked with x-iterate-worker-building — intercept it here to render
      // your own). Method calls on apps still go through
      // `project.workers.get(ref)` RPC dispatch; HTTP never does.
      const headers = new Headers(req.headers);
      headers.set("x-iterate-worker-dispatch", JSON.stringify({ buildBudgetMs: 15_000, ref }));
      return await this.env.ITX.fetch(new Request(req, { headers }));
    }

    // The seeded homepage is a static page linking to the apps. Platform
    // hosts use "<app>--<project>.<base>"; custom domains use
    // "<app>.<custom-hostname>".
    const url = new URL(req.url);
    const hostKind = req.headers.get("x-iterate-host-kind");
    const appLinks = Object.entries(APPS)
      .map(([slug, ref]) => {
        const appHost = hostKind === "custom" ? `${slug}.${url.host}` : `${slug}--${url.host}`;
        const href = `${url.protocol}//${appHost}/`;
        return `<li><a href="${href}">${slug}</a> (${ref.type})</li>`;
      })
      .join("\n");
    return new Response(
      `<!doctype html>
        <html>
          <body>
            <main>
              <p>Hello from your Iterate project worker.</p>
              <ul>${appLinks}</ul>
              <p>Edit worker.ts in the project repo to change this.</p>
            </main>
          </body>
        </html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  override async processEventBatch(batch: StreamEventBatch): Promise<void> {
    // Agent streams run through the compaction processor before the per-event
    // reactions below. A fresh instance per delivery is correct: the contract
    // is stateless, and `keepAliveWhile` bridges its background summary work
    // onto this invocation's waitUntil.
    if (batch.path.startsWith("/agents/")) {
      const itx = await this.env.ITX.get();
      const compaction = new CompactionProcessor({
        stream: itx.streams.get(batch.path),
        keepAliveWhile: (work) => this.ctx.waitUntil(work()),
        agent: itx.agents.get(batch.path),
        ai: itx.ai,
      });
      await compaction.ingest({ events: batch.events, streamMaxOffset: batch.streamMaxOffset });
    }
    await super.processEventBatch(batch);
  }

  override async processEvent(event: StreamEvent): Promise<void> {
    // React to anything happening anywhere in the project: one `if` per
    // reaction, keyed on event.path + event.type. Delivery is at-least-once,
    // so anything a reaction appends carries an idempotency key.

    // THIS WORKER configures new agents. When any stream under /agents/ is
    // born (a web chat, the onboarding agent, a Slack thread, an email
    // thread), the platform announces it on the project root stream and this
    // reaction appends the agent's policy: system prompt, model/provider,
    // capability mounts, boot context. `itx.agents.defaults.forPath` returns
    // the platform's defaults as data — edit the result (or pass overrides:
    // { systemPrompt, provider, model }) to change how YOUR agents behave.
    if (event.path === "/" && event.type === "events.iterate.com/stream/child-stream-created") {
      const childPath = event.payload?.childPath;
      if (typeof childPath === "string" && childPath.startsWith("/agents/")) {
        const itx = await this.env.ITX.get();
        const defaults = await itx.agents.defaults.forPath(childPath);
        await itx.streams.get(childPath).append(...defaults.events);
      }
    }
  }

  /**
   * The platform dispatches dotted calls on this worker as ONE flattened
   * `invokeCapability({ path, args })` call, and this userspace method walks
   * the path over the worker itself. That is what lets the `slack` and
   * `waitrose` getters below hand back raw SDK clients: nothing ever crosses
   * RPC except the final method's arguments and result, so
   * `itx.worker.slack.chat.postMessage({...})` — or any nested surface a
   * getter returns — is a single round trip into plain userland code.
   */
  async invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    let receiver: unknown = this;
    for (const segment of path.slice(0, -1)) {
      receiver = await Reflect.get(Object(receiver), segment);
    }
    const method = path.at(-1)!;
    const handler = Reflect.get(Object(receiver), method);
    if (typeof handler !== "function") {
      throw new Error(`"${path.join(".")}" is not a method on this project worker`);
    }
    return await Reflect.apply(handler, receiver, args);
  }

  /**
   * Slack Web API surface: the real `@slack/web-api` SDK from package.json,
   * configured by the `slackConfig` constant at the top of this file. Only
   * ever reached through the userspace `invokeCapability` walk above, so the
   * client needs no RPC-safe projection.
   */
  get slack(): WebClient {
    const client = new WebClient(slackConfig.token || undefined, {
      ...(slackConfig.slackApiUrl === null ? {} : { slackApiUrl: slackConfig.slackApiUrl }),
    });
    // The SDK's axios defaults to its node-http adapter, whose response
    // handling hangs under the Workers runtime; the fetch adapter rides the
    // platform's native fetch (and therefore project egress) instead.
    (client as unknown as { axios: { defaults: { adapter: string } } }).axios.defaults.adapter =
      "fetch";
    return client;
  }

  /**
   * Waitrose surface (the reference userspace integration): the vendored
   * client from integrations/waitrose/client.ts, one per connection —
   * `itx.worker.waitrose.<connection>.<method>(...)`. Durable by
   * construction: this worker always exists and is late-bound to the repo,
   * so there is no mount step and nothing session-owned to expire. The
   * bearer is a `getSecret(...)` placeholder substituted at project egress;
   * this code never sees a session token (the secret's own Durable Object
   * logs in on first use and re-logins on 401 — see the README there).
   */
  get waitrose(): Record<string, ReturnType<typeof waitroseClient>> {
    return new Proxy({} as Record<string, ReturnType<typeof waitroseClient>>, {
      get: (_target, connection) =>
        // "then" guard: the dispatch walk awaits each segment, and awaiting
        // the proxy itself must not conjure a client named "then".
        typeof connection !== "string" || connection === "then"
          ? undefined
          : waitroseClient({
              authorization: `Bearer getSecret({ path: "/secrets/integrations/waitrose/${connection}/session", field: "accessToken" })`,
            }),
    });
  }
}
