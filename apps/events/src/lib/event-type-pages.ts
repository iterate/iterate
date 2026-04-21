import {
  type EventInput,
  type EventType,
  type JSONObject,
  SCHEDULE_CANCELLED_TYPE,
  SCHEDULE_CONFIGURED_TYPE,
  SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE,
  SCHEDULE_INTERNAL_EXECUTION_STARTED_TYPE,
  STREAM_APPEND_SCHEDULED_TYPE,
} from "@iterate-com/events-contract";

export type EventTypePageDefinition = {
  readonly slug: string;
  readonly href: `/${string}/`;
  readonly title: string;
  readonly type: EventType;
  readonly summary: string;
  readonly payloadExample?: JSONObject;
  readonly templates?: readonly EventInputTemplateDefinition[];
  readonly details?: readonly string[];
};

export type EventInputTemplateDefinition = {
  readonly id: string;
  readonly label: string;
  readonly event: EventInput;
};

export const streamInitializedPage = {
  slug: "stream-initialized",
  href: "/stream-initialized/",
  title: "Stream Initialized",
  type: "https://events.iterate.com/events/stream/initialized",
  summary: "Internal meta event emitted exactly once when a stream initializes itself.",
  payloadExample: {
    projectSlug: "public",
    path: "/demo/stream",
  },
  details: [
    "Every initialized stream writes its own self-initialized event at offset 1 before any caller-appended events.",
    "Parent/root discovery uses a separate built-in child-stream-created event.",
    "It is useful for reasoning about a stream's own lifecycle and offset invariants.",
  ],
} satisfies EventTypePageDefinition;

export const streamDurableObjectConstructedPage = {
  slug: "stream-durable-object-constructed",
  href: "/stream-durable-object-constructed/",
  title: "Stream Durable Object Constructed",
  type: "https://events.iterate.com/events/stream/durable-object-constructed",
  summary:
    "Internal meta event emitted when a previously initialized stream durable object wakes and reconstructs itself from persisted state.",
  payloadExample: {},
  details: [
    "This only appears after the durable object constructor rehydrates an already initialized stream from SQLite state.",
    "Fresh streams do not emit it on first initialize because there is no prior reduced state to rehydrate.",
    "It is useful when debugging durable object cold starts, hibernation, and resume behavior.",
  ],
} satisfies EventTypePageDefinition;

export const streamMetadataUpdatedPage = {
  slug: "stream-metadata-updated",
  href: "/stream-metadata-updated/",
  title: "Stream Metadata Updated",
  type: "https://events.iterate.com/events/stream/metadata-updated",
  summary: "Internal metadata event that replaces the reduced metadata snapshot for a stream.",
  payloadExample: {
    metadata: {
      owner: "demo",
      environment: "dev",
    },
  },
  details: [
    "The reducer treats this payload as a full metadata replacement rather than a patch merge.",
    "Use it when stream-level metadata should change without inventing a separate mutation API.",
  ],
} satisfies EventTypePageDefinition;

export const childStreamCreatedPage = {
  slug: "child-stream-created",
  href: "/child-stream-created/",
  title: "Child Stream Created",
  type: "https://events.iterate.com/events/stream/child-stream-created",
  summary:
    "Built-in event propagated to a parent stream when a new child stream is initialized beneath it.",
  payloadExample: {
    childPath: "/demo/stream/child",
  },
  details: [
    "When a nested stream initializes, the system appends this event to each ancestor stream in the path hierarchy.",
    "Only the first append to a child stream triggers propagation — subsequent appends do not repeat it.",
  ],
} satisfies EventTypePageDefinition;

export const errorOccurredPage = {
  slug: "error-occurred",
  href: "/error-occurred/",
  title: "Error Occurred",
  type: "https://events.iterate.com/events/stream/error-occurred",
  summary: "Built-in error event for recording failures directly in a stream.",
  payloadExample: {
    message: "Failed to fetch remote state",
  },
  details: [
    "Use this when a stream should record an operational failure as an event instead of only logging it.",
    "The built-in payload shape only requires a human-readable message.",
  ],
} satisfies EventTypePageDefinition;

export const streamAppendScheduledPage = {
  slug: "stream-append-scheduled",
  href: "/stream-append-scheduled/",
  title: "Append Scheduled",
  type: STREAM_APPEND_SCHEDULED_TYPE,
  summary:
    "Built-in ergonomic scheduling event that asks the stream to append another event later using a named slug.",
  payloadExample: {
    slug: "daily-rollup",
    append: {
      type: "https://events.iterate.com/events/example/rollup-requested",
      payload: {
        source: "scheduler",
      },
    },
    schedule: {
      kind: "once-in",
      delaySeconds: 30,
    },
  },
  details: [
    "This is the ergonomic public trigger event. The scheduler processor rewrites it into the canonical low-level `schedule/configured` control event after commit.",
    "Use it when the desired callback is simply `append` another event back into the same stream.",
  ],
  templates: [
    {
      id: "stream-append-scheduled:once-in",
      label: "Append Scheduled · Once in 30s",
      event: {
        type: STREAM_APPEND_SCHEDULED_TYPE,
        payload: {
          slug: "daily-rollup",
          append: {
            type: "https://events.iterate.com/events/example/rollup-requested",
            payload: {
              source: "scheduler",
            },
          },
          schedule: {
            kind: "once-in",
            delaySeconds: 30,
          },
        },
      },
    },
    {
      id: "stream-append-scheduled:every",
      label: "Append Scheduled · Every 5m",
      event: {
        type: STREAM_APPEND_SCHEDULED_TYPE,
        payload: {
          slug: "heartbeat",
          append: {
            type: "https://events.iterate.com/events/example/heartbeat",
            payload: {
              source: "scheduler",
            },
          },
          schedule: {
            kind: "every",
            intervalSeconds: 300,
          },
        },
      },
    },
  ],
} satisfies EventTypePageDefinition;

export const scheduleConfiguredPage = {
  slug: "schedule-configured",
  href: "/schedule-configured/",
  title: "Schedule Configured",
  type: SCHEDULE_CONFIGURED_TYPE,
  summary:
    "Built-in canonical scheduler control event that upserts a schedule by slug into reduced processor state.",
  payloadExample: {
    slug: "daily-rollup",
    callback: "append",
    payloadJson: JSON.stringify(
      {
        type: "https://events.iterate.com/events/example/rollup-requested",
        payload: {
          source: "scheduler",
        },
      },
      null,
      2,
    ),
    schedule: {
      kind: "once-in",
      delaySeconds: 30,
    },
    nextRunAt: 1_775_592_400,
  },
  details: [
    "This is the canonical low-level scheduler event. Appending it directly is the most explicit way to configure or replace a schedule by slug.",
    "The reducer stores this in `state.processors.scheduler`; the Durable Object alarm is then derived from that reduced state.",
    "Only explicitly schedulable callbacks can run. `append` is built in; custom stream subclasses must opt in extra callback names deliberately.",
  ],
  templates: [
    {
      id: "schedule-configured:once-in",
      label: "Schedule Configured · Once in 30s",
      event: {
        type: SCHEDULE_CONFIGURED_TYPE,
        payload: {
          slug: "daily-rollup",
          callback: "append",
          payloadJson: JSON.stringify({
            type: "https://events.iterate.com/events/example/rollup-requested",
            payload: {
              source: "scheduler",
            },
          }),
          schedule: {
            kind: "once-in",
            delaySeconds: 30,
          },
          nextRunAt: 1_775_592_400,
        },
      },
    },
    {
      id: "schedule-configured:cron",
      label: "Schedule Configured · Cron",
      event: {
        type: SCHEDULE_CONFIGURED_TYPE,
        payload: {
          slug: "daily-rollup",
          callback: "append",
          payloadJson: JSON.stringify({
            type: "https://events.iterate.com/events/example/rollup-requested",
            payload: {
              source: "scheduler",
            },
          }),
          schedule: {
            kind: "cron",
            cron: "0 * * * *",
          },
          nextRunAt: 1_775_596_000,
        },
      },
    },
  ],
} satisfies EventTypePageDefinition;

export const scheduleCancelledPage = {
  slug: "schedule-cancelled",
  href: "/schedule-cancelled/",
  title: "Schedule Cancelled",
  type: SCHEDULE_CANCELLED_TYPE,
  summary: "Built-in control event that removes the configured schedule for a slug.",
  payloadExample: {
    slug: "daily-rollup",
  },
  details: [
    "Cancellation is keyed only by slug. The latest configured schedule for that slug stops being eligible to run.",
  ],
} satisfies EventTypePageDefinition;

export const scheduleExecutionStartedPage = {
  slug: "schedule-execution-started",
  href: "/schedule-execution-started/",
  title: "Schedule Execution Started",
  type: SCHEDULE_INTERNAL_EXECUTION_STARTED_TYPE,
  summary:
    "Internal scheduler bookkeeping event emitted before an interval execution begins running.",
  payloadExample: {
    slug: "heartbeat",
    startedAt: 1_775_592_400,
  },
  details: [
    "This is an internal runtime event, not the recommended public authoring surface.",
    "It exists so the reduced scheduler state can track overlap and hung-interval recovery durably.",
  ],
} satisfies EventTypePageDefinition;

export const scheduleExecutionFinishedPage = {
  slug: "schedule-execution-finished",
  href: "/schedule-execution-finished/",
  title: "Schedule Execution Finished",
  type: SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE,
  summary:
    "Internal scheduler bookkeeping event emitted after an attempted execution, including success/failure and the next run time.",
  payloadExample: {
    slug: "heartbeat",
    outcome: "succeeded",
    nextRunAt: 1_775_592_700,
  },
  details: [
    "This is an internal runtime event, not the recommended public authoring surface.",
    "A `null` `nextRunAt` retires the schedule; a numeric `nextRunAt` keeps it active for the next alarm cycle.",
  ],
} satisfies EventTypePageDefinition;

export const jsonataTransformerConfiguredPage = {
  slug: "jsonata-transformer-configured",
  href: "/jsonata-transformer-configured/",
  title: "JSONata Transformer Configured",
  type: "https://events.iterate.com/events/stream/jsonata-transformer-configured",
  summary:
    "Built-in control event that registers or replaces an append-time JSONata transformer by slug.",
  payloadExample: {
    slug: "normalize-webhook",
    matcher: "type = 'webhook.raw'",
    transform: '{"type":"webhook.normalized","payload":{"body":payload}}',
  },
  details: [
    "The latest configured event for a slug replaces the previous matcher and transform.",
    "Transformers evaluate against the full committed event envelope, not just payload.",
  ],
  templates: [
    {
      id: "jsonata-transformer-configured:slack-webhook",
      label: "JSONata Transformer Configured · Slack webhook",
      event: {
        type: "https://events.iterate.com/events/stream/jsonata-transformer-configured",
        payload: {
          slug: "slack-webhook",
          matcher:
            "type = 'https://events.iterate.com/events/stream/invalid-event-appended' and payload.rawInput.command = '/iterate'",
          transform: `{
  "type":"https://events.iterate.com/events/example/slack-webhook-received",
  "payload":{
    "teamId":payload.rawInput.team_id,
    "channelId":payload.rawInput.channel_id,
    "userId":payload.rawInput.user_id,
    "command":payload.rawInput.command,
    "text":payload.rawInput.text
  },
  "metadata":{
    "source":"slack-webhook",
    "teamDomain":payload.rawInput.team_domain
  }
}`,
        },
      },
    },
  ],
} satisfies EventTypePageDefinition;

export const streamSubscriptionConfiguredPage = {
  slug: "stream-subscription-configured",
  href: "/stream-subscription-configured/",
  title: "Stream Subscription Configured",
  type: "https://events.iterate.com/events/stream/subscription/configured",
  summary:
    "Built-in control event that upserts an external subscriber by slug, using either websocket fanout or fire-and-forget webhook delivery.",
  payloadExample: {
    slug: "processor:ping-pong",
    callbackUrl: "ws://127.0.0.1:8788/after-event-handler?streamPath=%2Fdemo",
    type: "websocket",
  },
  details: [
    "The latest configured event for a slug replaces the previous subscriber config for that slug.",
    "Both subscriber kinds can optionally use jsonataFilter against the full committed event envelope.",
    "Only webhook subscribers apply jsonataTransform; websocket subscribers use a stable framed protocol instead of arbitrary transformed payloads.",
  ],
  templates: [
    {
      id: "stream-subscription-configured:websocket-processor",
      label: "Subscription Configured · Websocket processor",
      event: {
        type: "https://events.iterate.com/events/stream/subscription/configured",
        payload: {
          slug: "processor:ping-pong",
          callbackUrl: "ws://127.0.0.1:8788/after-event-handler?streamPath=%2Fdemo",
          type: "websocket",
        },
      },
    },
    {
      id: "stream-subscription-configured:webhook-audit",
      label: "Subscription Configured · Webhook audit",
      event: {
        type: "https://events.iterate.com/events/stream/subscription/configured",
        payload: {
          slug: "audit",
          callbackUrl: "https://example.com/hooks/events",
          type: "webhook",
          jsonataFilter: 'type = "demo-message"',
          jsonataTransform: '{"kind":"audit","path":streamPath,"payload":payload}',
        },
      },
    },
  ],
} satisfies EventTypePageDefinition;

const pingPongDynamicWorkerTemplateScript = `
export default {
  slug: "ping-pong",
  initialState: {},

  reduce({ state }) {
    return state;
  },

  async afterAppend({ append, event }) {
    if (
      event.type === "https://events.iterate.com/events/stream/dynamic-worker/configured" ||
      !/\\bping\\b/i.test(
        JSON.stringify({
          type: event.type,
          payload: event.payload,
          metadata: event.metadata ?? null,
        }),
      )
    ) {
      return;
    }

    await append({
      event: {
        type: "pong",
      },
    });
  },
};
`.trim();

export const dynamicWorkerConfiguredPage = {
  slug: "dynamic-worker-configured",
  href: "/dynamic-worker-configured/",
  title: "Dynamic Worker Configured",
  type: "https://events.iterate.com/events/stream/dynamic-worker/configured",
  summary:
    "Built-in control event that registers or replaces a dynamic worker processor by slug for a stream.",
  payloadExample: {
    slug: "ping-pong",
    script: pingPongDynamicWorkerTemplateScript,
  },
  details: [
    "The latest configured event for a slug replaces the previous dynamic worker runtime for that slug on the same stream.",
    "The raw composer template uses `script` directly so it is copy-pastable without any bundling or dependencies.",
    "If `outboundGateway` is omitted, the dynamic worker uses the default `DynamicWorkerEgressGateway`, so outbound requests can resolve `getIterateSecret(...)` header sentinels.",
    'This trivial example replies with `{ type: "pong" }` whenever a later event contains the word `ping`.',
  ],
  templates: [
    {
      id: "dynamic-worker-configured:openai-fetch-append",
      label: "Dynamic Worker Configured · OpenAI fetch append",
      event: {
        type: "https://events.iterate.com/events/stream/dynamic-worker/configured",
        payload: {
          slug: "openai-fetch-append",
          script: `
export default {
  initialState: { history: [] },

  reduce({ state, event }) {
    if (event.type === "agent-input-added" && typeof event.payload?.content === "string") {
      return {
        history: [
          ...state.history,
          {
            role: event.payload.role === "assistant" ? "assistant" : "user",
            content: event.payload.content,
          },
        ],
      };
    }

    return state;
  },

  async afterAppend({ append, event, state }) {
    if (event.type === "agent-input-added" && event.payload?.role === "user") {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: \`Bearer \${process.env.OPENAI_API_KEY}\`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          input: state.history,
        }),
      });

      await append({
        event: {
          type: "https://events.iterate.com/events/example/openai-response-body-added",
          payload: {
            ok: response.ok,
            status: response.status,
            body: await response.text(),
          },
        },
      });

      return;
    }

    if (
      event.type !== "https://events.iterate.com/events/example/openai-response-body-added" ||
      event.payload?.ok !== true ||
      typeof event.payload?.body !== "string"
    ) {
      return;
    }

    const content = (JSON.parse(event.payload.body).output ?? [])
      .flatMap((item) =>
        item?.role === "assistant" && Array.isArray(item.content) ? item.content : [],
      )
      .flatMap((item) =>
        item?.type === "output_text" && typeof item.text === "string" ? [item.text] : [],
      )
      .join("\\n\\n")
      .trim();

    if (!content) {
      return;
    }

    await append({
      event: {
        type: "agent-input-added",
        payload: {
          role: "assistant",
          content,
        },
      },
    });
  },
};
          `.trim(),
        },
      },
    },
  ],
} satisfies EventTypePageDefinition;

const dynamicWorkerEnvVarSetPage = {
  slug: "dynamic-worker-env-var-set",
  href: "/dynamic-worker-env-var-set/",
  title: "Dynamic Worker Env Var Set",
  type: "https://events.iterate.com/events/stream/dynamic-worker/env-var-set",
  summary:
    "Built-in control event that stores a stream-wide env var string to inject into dynamic workers via `process.env`.",
  payloadExample: {
    key: "OPENAI_API_KEY",
    value: 'getIterateSecret({secretKey: "openai"})',
  },
  details: [
    "The value is injected literally into the dynamic worker env bindings, so processor code reads the same raw string from `process.env`.",
    "This is designed for SDKs that expect credentials in `process.env`, while keeping `getIterateSecret(...)` resolution in the outbound egress proxy.",
    "If a worker never sends the value back out in a request header, the placeholder stays a plain string and is not resolved automatically.",
  ],
} satisfies EventTypePageDefinition;

export const streamPausedPage = {
  slug: "stream-paused",
  href: "/stream-paused/",
  title: "Stream Paused",
  type: "https://events.iterate.com/events/stream/paused",
  summary: "Built-in control event that marks a stream as temporarily rejecting new events.",
  payloadExample: {
    reason: "circuit breaker tripped: burst rate limit exceeded",
  },
  details: [
    "While paused, the durable object rejects all new appends except `stream/resumed`.",
    "The circuit breaker processor can emit this event automatically.",
  ],
} satisfies EventTypePageDefinition;

export const streamResumedPage = {
  slug: "stream-resumed",
  href: "/stream-resumed/",
  title: "Stream Resumed",
  type: "https://events.iterate.com/events/stream/resumed",
  summary: "Built-in control event that re-opens a paused stream for new appends.",
  payloadExample: {
    reason: "operator override",
  },
  details: [
    "This is the only event type allowed through while a stream is paused.",
    "Resuming clears the active paused state so normal appends can continue.",
  ],
} satisfies EventTypePageDefinition;

export const manualEventAppendedPage = {
  slug: "manual-event-appended",
  href: "/manual-event-appended/",
  title: "Manual Event Appended",
  type: "https://events.iterate.com/manual-event-appended",
  summary:
    "Small hand-written example event for trying the UI and proving that an event type can have its own real page route.",
  payloadExample: {
    message: "hello",
  },
  details: [
    "Use this as the copy-paste template when you want to add another event type page.",
    "The route slug can stay short and human-readable even when the full event type is a longer URL.",
  ],
} satisfies EventTypePageDefinition;

export const agentInputAddedPage = {
  slug: "agent-input-added",
  href: "/agent-input-added/",
  title: "Agent Input Added",
  type: "agent-input-added",
  summary: "Message turn for agent-style processors (dynamic worker loops, OpenAI, and similar).",
  payloadExample: {
    role: "user",
    content: "Tell me a joke I never heard before",
  },
  details: [
    "Append this after configuring a processor that listens for agent-input-added.",
    "The pretty feed renders it as a user or assistant message based on payload.role; if omitted, role defaults to user.",
  ],
} satisfies EventTypePageDefinition;

export const bashmodeBlockAddedPage = {
  slug: "bashmode-block-added",
  href: "/bashmode-block-added/",
  title: "Bashmode Block Added",
  type: "bashmode-block-added",
  summary:
    "Shell script payload for processors that run bash after append (workshop bashmode pattern).",
  payloadExample: {
    script: [
      "curl -sH 'Content-Type: application/json'  \\",
      '  --data \'{"type": "hello-world"}\' \\',
      '  "https://events.iterate.com/api/streams/"',
    ].join("\n"),
  },
  details: [
    "Use with a processor whose afterAppend runs the script (see the workshop bashmode example).",
    "Typically paired with appending agent-input-added with the command output.",
  ],
} satisfies EventTypePageDefinition;

export const eventTypePages = [
  agentInputAddedPage,
  bashmodeBlockAddedPage,
  dynamicWorkerEnvVarSetPage,
  childStreamCreatedPage,
  dynamicWorkerConfiguredPage,
  errorOccurredPage,
  jsonataTransformerConfiguredPage,
  manualEventAppendedPage,
  scheduleCancelledPage,
  scheduleConfiguredPage,
  scheduleExecutionFinishedPage,
  scheduleExecutionStartedPage,
  streamAppendScheduledPage,
  streamDurableObjectConstructedPage,
  streamInitializedPage,
  streamMetadataUpdatedPage,
  streamPausedPage,
  streamResumedPage,
  streamSubscriptionConfiguredPage,
] as const satisfies readonly EventTypePageDefinition[];

export function getEventTypePageByType(type: string) {
  return eventTypePages.find((page) => page.type === type);
}

export const eventInputTemplates = (eventTypePages as readonly EventTypePageDefinition[]).flatMap(
  (page) => [
    {
      id: `${page.slug}:default`,
      label: page.title,
      event: {
        type: page.type,
        payload: page.payloadExample ?? {},
      } satisfies JSONObject,
    },
    ...(page.templates ?? []),
  ],
) satisfies readonly EventInputTemplateDefinition[];

export function getEventInputTemplateById(id: string) {
  return eventInputTemplates.find((template) => template.id === id);
}
