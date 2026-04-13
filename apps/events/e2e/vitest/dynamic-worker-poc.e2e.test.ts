/**
 * Dedicated runtime checks for the dynamic worker processor.
 * Set `EVENTS_BASE_URL` before running the suite.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { type EventInput, type StreamPath } from "@iterate-com/events-contract";
import { pingPongDynamicWorkerScript } from "../../src/durable-objects/dynamic-processor.ts";
import { createEvents2AppFixture, requireEventsBaseUrl } from "../helpers.ts";

const eventsBaseUrl = requireEventsBaseUrl();
const app = createEvents2AppFixture({
  baseURL: eventsBaseUrl,
});
const configuredEventType = "https://events.iterate.com/events/stream/dynamic-worker/configured";
const envVarSetEventType = "https://events.iterate.com/events/stream/dynamic-worker/env-var-set";
const envVarObservedEventType = "https://events.iterate.com/events/example/env-var-observed";
const httpbinEchoedEventType = "https://events.iterate.com/events/example/httpbin-echoed";
const valueRecordedEventType = "https://events.iterate.com/events/example/value-recorded";
const nextEventTimeoutMs = 10_000;
const idleEventTimeoutMs = 500;
const altPongDynamicWorkerScript = pingPongDynamicWorkerScript.replace(
  'await append({\n      event: {\n        type: "pong",\n      },\n    });',
  'await append({\n      event: {\n        type: "alt-pong",\n      },\n    });',
);
const altPongADynamicWorkerScript = pingPongDynamicWorkerScript.replace(
  'await append({\n      event: {\n        type: "pong",\n      },\n    });',
  'await append({\n      event: {\n        type: "alt-pong-a",\n      },\n    });',
);
const altPongBDynamicWorkerScript = pingPongDynamicWorkerScript.replace(
  'await append({\n      event: {\n        type: "pong",\n      },\n    });',
  'await append({\n      event: {\n        type: "alt-pong-b",\n      },\n    });',
);
const onEventPingPongDynamicWorkerScript = `
export default {
  initialState: { seen: 0 },

  reduce({ state, event }) {
    if (event.type === "https://events.iterate.com/events/stream/dynamic-worker/configured") {
      return state;
    }

    if (!/\\bping\\b/i.test(JSON.stringify({ type: event.type, payload: event.payload }))) {
      return state;
    }

    return {
      seen: state.seen + 1,
    };
  },

  async onEvent({ append, event, prevState, state }) {
    if (
      event.type === "https://events.iterate.com/events/stream/dynamic-worker/configured" ||
      !/\\bping\\b/i.test(JSON.stringify({ type: event.type, payload: event.payload }))
    ) {
      return;
    }

    await append({
      type: "legacy-pong",
      payload: {
        previousSeen: prevState.seen,
        seen: state.seen,
      },
    });
  },
};
`.trim();
const noInitialStateDynamicWorkerScript = `
export default {
  slug: "no-initial-state",

  async afterAppend({ append, event }) {
    if (event.type !== "${valueRecordedEventType}") {
      return;
    }

    await append({
      event: {
        type: "${envVarObservedEventType}",
        payload: {
          sawMessage: event.payload?.message ?? null,
        },
      },
    });
  },
};
`.trim();
const envVarObserverDynamicWorkerScript = `
export default {
  initialState: {},

  reduce({ state }) {
    return state;
  },

  async afterAppend({ append, event }) {
    if (event.type !== "${valueRecordedEventType}") {
      return;
    }

    await append({
      event: {
        type: "${envVarObservedEventType}",
        payload: {
          key: "OPENAI_API_KEY",
          value: process.env.OPENAI_API_KEY ?? null,
        },
      },
    });
  },
};
`.trim();
const envVarEgressDynamicWorkerScript = `
function normalizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [String(key).toLowerCase(), value]),
  );
}

export default {
  initialState: {},

  reduce({ state }) {
    return state;
  },

  async afterAppend({ append, event }) {
    if (event.type !== "${valueRecordedEventType}") {
      return;
    }

    const authorization = \`Bearer \${process.env.OPENAI_API_KEY ?? ""}\`;
    await append({
      event: {
        type: "${envVarObservedEventType}",
        payload: {
          key: "OPENAI_API_KEY",
          value: process.env.OPENAI_API_KEY ?? null,
          authorization,
        },
      },
    });

    const response = await fetch("https://httpbin.org/headers", {
      headers: {
        authorization,
      },
    });
    const responseJson = await response.json();

    await append({
      event: {
        type: "${httpbinEchoedEventType}",
        payload: {
          ok: response.ok,
          status: response.status,
          normalizedHeaders: normalizeHeaders(responseJson.headers),
          response: responseJson,
        },
      },
    });
  },
};
`.trim();

describe("dynamic worker processor", () => {
  test("subscribes once and appends pong for later ping payloads", async () => {
    const path = uniqueDynamicWorkerPath();
    const iterator = await openLiveIterator(path);

    try {
      await expectInitialized(iterator, path);
      await configureWorker({
        path,
        slug: "ping-pong",
        script: pingPongDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "ping-pong");

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "hello ping world" },
      });

      await expectEvent(iterator, {
        streamPath: path,
        type: valueRecordedEventType,
        payload: { message: "hello ping world" },
      });
      await expectEvent(iterator, { streamPath: path, type: "pong" });

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "plain hello world" },
      });

      await expectEvent(iterator, {
        streamPath: path,
        type: valueRecordedEventType,
        payload: { message: "plain hello world" },
      });
      await expectEventCount(path, 5);

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "second ping from payload" },
      });

      await expectEvent(iterator, {
        streamPath: path,
        type: valueRecordedEventType,
        payload: { message: "second ping from payload" },
      });
      await expectEvent(iterator, { streamPath: path, type: "pong" });

      expect(await app.client.getState({ path })).toMatchObject({
        path,
        eventCount: 7,
        metadata: {},
        processors: {
          "circuit-breaker": {
            paused: false,
            pauseReason: null,
            pausedAt: null,
            availableTokens: expect.any(Number),
            lastRefillAtMs: expect.any(Number),
          },
          "dynamic-worker": {
            workersBySlug: {
              "ping-pong": {
                compatibilityDate: "2026-02-05",
                compatibilityFlags: [],
                mainModule: "worker.js",
                modules: {
                  "processor.js": pingPongDynamicWorkerScript,
                  "runtime-config.js": expect.any(String),
                  "worker.js": expect.any(String),
                },
              },
            },
          },
          "jsonata-transformer": {
            transformersBySlug: {},
          },
        },
      });
    } finally {
      await iterator.return?.();
    }
  });

  test("does not react to its own configuration event even though the script contains ping", async () => {
    const path = uniqueDynamicWorkerPath();
    const iterator = await openLiveIterator(path);

    try {
      await expectInitialized(iterator, path);
      await configureWorker({
        path,
        slug: "ping-pong",
        script: pingPongDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "ping-pong");
      await expectEventCount(path, 2);
    } finally {
      await iterator.return?.();
    }
  });

  test("runs onEvent dynamic worker bundles with the canonical reducer contract", async () => {
    const path = uniqueDynamicWorkerPath();
    const iterator = await openLiveIterator(path);

    try {
      await expectInitialized(iterator, path);
      await configureWorker({
        path,
        slug: "on-event-ping-pong",
        script: onEventPingPongDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "on-event-ping-pong");

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "legacy ping" },
      });

      await expectEvent(iterator, {
        streamPath: path,
        type: valueRecordedEventType,
        payload: { message: "legacy ping" },
      });
      await expectEvent(iterator, {
        streamPath: path,
        type: "legacy-pong",
        payload: {
          previousSeen: 0,
          seen: 1,
        },
      });
    } finally {
      await iterator.return?.();
    }
  });

  test("matches ping in payload, type, metadata, and uppercase forms", async () => {
    const path = uniqueDynamicWorkerPath();
    const iterator = await openLiveIterator(path);

    try {
      await expectInitialized(iterator, path);
      await configureWorker({
        path,
        slug: "ping-pong",
        script: pingPongDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "ping-pong");

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "PING from payload" },
      });
      await expectEvent(iterator, { streamPath: path, type: valueRecordedEventType });
      await expectEvent(iterator, { streamPath: path, type: "pong" });

      await append(path, {
        type: "https://events.iterate.com/events/example/ping-observed",
        payload: { value: 1 },
      });
      await expectEvent(iterator, {
        streamPath: path,
        type: "https://events.iterate.com/events/example/ping-observed",
      });
      await expectEvent(iterator, { streamPath: path, type: "pong" });

      await append(path, {
        type: valueRecordedEventType,
        payload: { value: 2 },
        metadata: { note: "metadata ping marker" },
      });
      await expectEvent(iterator, {
        streamPath: path,
        type: valueRecordedEventType,
        metadata: { note: "metadata ping marker" },
      });
      await expectEvent(iterator, { streamPath: path, type: "pong" });
      await expectEventCount(path, 8);
    } finally {
      await iterator.return?.();
    }
  });

  test("ignores substring matches without a word boundary and still matches hyphenated ping", async () => {
    const path = uniqueDynamicWorkerPath();
    const iterator = await openLiveIterator(path);

    try {
      await expectInitialized(iterator, path);
      await configureWorker({
        path,
        slug: "ping-pong",
        script: pingPongDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "ping-pong");

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "camping trip" },
      });
      await expectEvent(iterator, {
        streamPath: path,
        type: valueRecordedEventType,
        payload: { message: "camping trip" },
      });
      await expectEventCount(path, 3);

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "ping-pong table" },
      });
      await expectEvent(iterator, {
        streamPath: path,
        type: valueRecordedEventType,
        payload: { message: "ping-pong table" },
      });
      await expectEvent(iterator, { streamPath: path, type: "pong" });
      await expectEventCount(path, 5);
    } finally {
      await iterator.return?.();
    }
  });

  test("starts lazily on the first later event and stays subscribed after a non-matching event", async () => {
    const path = uniqueDynamicWorkerPath();
    const iterator = await openLiveIterator(path);

    try {
      await expectInitialized(iterator, path);
      await configureWorker({
        path,
        slug: "ping-pong",
        script: pingPongDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "ping-pong");

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "nothing to see here" },
      });
      await expectEvent(iterator, {
        streamPath: path,
        type: valueRecordedEventType,
        payload: { message: "nothing to see here" },
      });
      await expectEventCount(path, 3);

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "ping after lazy start" },
      });
      await expectEvent(iterator, {
        streamPath: path,
        type: valueRecordedEventType,
        payload: { message: "ping after lazy start" },
      });
      await expectEvent(iterator, { streamPath: path, type: "pong" });
      await expectEventCount(path, 5);
    } finally {
      await iterator.return?.();
    }
  });

  test("same slug configured twice hot-swaps to the latest runtime before the first matching event", async () => {
    const path = uniqueDynamicWorkerPath();
    const iterator = await openLiveIterator(path);

    try {
      await expectInitialized(iterator, path);
      await configureWorker({
        path,
        slug: "ping-pong",
        script: pingPongDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "ping-pong");
      await configureWorker({
        path,
        slug: "ping-pong",
        script: altPongDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "ping-pong");

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "the latest ping config should win" },
      });

      await expectEvent(iterator, {
        streamPath: path,
        type: valueRecordedEventType,
      });
      await expectEvent(iterator, { streamPath: path, type: "alt-pong" });
      await expectEventCount(path, 5);

      expect(await app.client.getState({ path })).toMatchObject({
        processors: {
          "dynamic-worker": {
            workersBySlug: {
              "ping-pong": {
                modules: {
                  "processor.js": altPongDynamicWorkerScript,
                },
              },
            },
          },
        },
      });
    } finally {
      await iterator.return?.();
    }
  });

  test("same slug reconfigured after activation cancels the old runtime and starts the new one", async () => {
    const path = uniqueDynamicWorkerPath();
    const iterator = await openLiveIterator(path);

    try {
      await expectInitialized(iterator, path);
      await configureWorker({
        path,
        slug: "ping-pong",
        script: pingPongDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "ping-pong");

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "first ping activates the runtime" },
      });
      await expectEvent(iterator, { streamPath: path, type: valueRecordedEventType });
      await expectEvent(iterator, { streamPath: path, type: "pong" });

      await configureWorker({
        path,
        slug: "ping-pong",
        script: altPongDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "ping-pong");

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "second ping should yield one alt-pong" },
      });
      await expectEvent(iterator, { streamPath: path, type: valueRecordedEventType });
      await expectEvent(iterator, { streamPath: path, type: "alt-pong" });
      await expectEventCount(path, 7);
    } finally {
      await iterator.return?.();
    }
  });

  test("same slug configured twice with identical code does not duplicate the live runtime", async () => {
    const path = uniqueDynamicWorkerPath();
    const iterator = await openLiveIterator(path);

    try {
      await expectInitialized(iterator, path);
      await configureWorker({
        path,
        slug: "ping-pong",
        script: pingPongDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "ping-pong");
      await configureWorker({
        path,
        slug: "ping-pong",
        script: pingPongDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "ping-pong");

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "only one ping response please" },
      });

      await expectEvent(iterator, { streamPath: path, type: valueRecordedEventType });
      await expectEvent(iterator, { streamPath: path, type: "pong" });
      await expectEventCount(path, 5);
    } finally {
      await iterator.return?.();
    }
  });

  test("concurrent same-slug reconfiguration does not leave a phantom live runtime behind", async () => {
    const path = uniqueDynamicWorkerPath();
    const iterator = await openLiveIterator(path);

    try {
      await expectInitialized(iterator, path);
      await configureWorker({
        path,
        slug: "ping-pong",
        script: pingPongDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "ping-pong");

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "activate the original ping worker" },
      });
      await expectEvent(iterator, { streamPath: path, type: valueRecordedEventType });
      await expectEvent(iterator, { streamPath: path, type: "pong" });

      await Promise.all([
        configureWorker({
          path,
          slug: "ping-pong",
          script: altPongADynamicWorkerScript,
        }),
        configureWorker({
          path,
          slug: "ping-pong",
          script: altPongBDynamicWorkerScript,
        }),
      ]);
      await expectConfiguredEvent(iterator, path, "ping-pong");
      await expectConfiguredEvent(iterator, path, "ping-pong");

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "warm the latest runtime without matching" },
      });
      await expectEvent(iterator, {
        streamPath: path,
        type: valueRecordedEventType,
        payload: { message: "warm the latest runtime without matching" },
      });

      const finalProcessorScript = (await app.client.getState({ path })).processors[
        "dynamic-worker"
      ].workersBySlug["ping-pong"]?.modules["processor.js"];

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "exactly one ping response after concurrent reconfig" },
      });
      await expectEvent(iterator, {
        streamPath: path,
        type: valueRecordedEventType,
        payload: { message: "exactly one ping response after concurrent reconfig" },
      });
      await expectEvent(iterator, {
        streamPath: path,
        type: finalProcessorScript === altPongADynamicWorkerScript ? "alt-pong-a" : "alt-pong-b",
      });
      await expectEventCount(path, 9);
    } finally {
      await iterator.return?.();
    }
  });

  test("distinct worker slugs each react once to the same matching event", async () => {
    const path = uniqueDynamicWorkerPath();
    const iterator = await openLiveIterator(path);

    try {
      await expectInitialized(iterator, path);
      await configureWorker({
        path,
        slug: "alpha",
        script: pingPongDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "alpha");
      await configureWorker({
        path,
        slug: "beta",
        script: pingPongDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "beta");

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "fan out the ping" },
      });

      await expectEvent(iterator, {
        streamPath: path,
        type: valueRecordedEventType,
      });
      await expectEvent(iterator, { streamPath: path, type: "pong" });
      await expectEvent(iterator, { streamPath: path, type: "pong" });
      await expectEventCount(path, 6);
    } finally {
      await iterator.return?.();
    }
  });

  test("hot-swapping one slug leaves the other live runtime untouched", async () => {
    const path = uniqueDynamicWorkerPath();
    const iterator = await openLiveIterator(path);

    try {
      await expectInitialized(iterator, path);
      await configureWorker({
        path,
        slug: "alpha",
        script: pingPongDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "alpha");
      await configureWorker({
        path,
        slug: "beta",
        script: pingPongDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "beta");
      await configureWorker({
        path,
        slug: "alpha",
        script: altPongDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "alpha");

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "fan out after one hot swap ping" },
      });

      await expectEvent(iterator, { streamPath: path, type: valueRecordedEventType });
      await expectEvent(iterator, { streamPath: path, type: "pong" });
      await expectEvent(iterator, { streamPath: path, type: "alt-pong" });
      await expectEventCount(path, 7);
    } finally {
      await iterator.return?.();
    }
  });

  test("module-based configuration works without the script shorthand", async () => {
    const path = uniqueDynamicWorkerPath();
    const iterator = await openLiveIterator(path);

    try {
      await expectInitialized(iterator, path);
      await append(path, {
        type: configuredEventType,
        payload: {
          slug: "modules-worker",
          modules: {
            "processor.ts": pingPongDynamicWorkerScript,
          },
        },
      });

      await expectConfiguredEvent(iterator, path, "modules-worker");

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "module ping works" },
      });

      await expectEvent(iterator, {
        streamPath: path,
        type: valueRecordedEventType,
      });
      await expectEvent(iterator, { streamPath: path, type: "pong" });
      await expectEventCount(path, 4);

      expect(await app.client.getState({ path })).toMatchObject({
        processors: {
          "dynamic-worker": {
            workersBySlug: {
              "modules-worker": {
                mainModule: "worker.js",
                modules: {
                  "processor.js": pingPongDynamicWorkerScript,
                  "runtime-config.js": expect.any(String),
                  "worker.js": expect.any(String),
                },
              },
            },
          },
        },
      });
    } finally {
      await iterator.return?.();
    }
  });

  test("defaults missing processor initialState to an empty object", async () => {
    const path = uniqueDynamicWorkerPath();
    const iterator = await openLiveIterator(path);

    try {
      await expectInitialized(iterator, path);
      await configureWorker({
        path,
        slug: "no-initial-state",
        script: noInitialStateDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "no-initial-state");

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "hello from missing initial state" },
      });

      await expectEvent(iterator, {
        streamPath: path,
        type: valueRecordedEventType,
        payload: { message: "hello from missing initial state" },
      });
      await expectEvent(iterator, {
        streamPath: path,
        type: envVarObservedEventType,
        payload: {
          sawMessage: "hello from missing initial state",
        },
      });
    } finally {
      await iterator.return?.();
    }
  });

  test("injects stream-wide env vars into process.env for configured workers", async () => {
    const path = uniqueDynamicWorkerPath();
    const iterator = await openLiveIterator(path);

    try {
      await expectInitialized(iterator, path);
      await setDynamicWorkerEnvVar({
        path,
        key: "OPENAI_API_KEY",
        value: "plain-demo-key",
      });
      await expectEvent(iterator, {
        streamPath: path,
        type: envVarSetEventType,
        payload: {
          key: "OPENAI_API_KEY",
          value: "plain-demo-key",
        },
      });
      await configureWorker({
        path,
        slug: "env-observer",
        script: envVarObserverDynamicWorkerScript,
      });
      await expectConfiguredEvent(iterator, path, "env-observer");

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "read the env var" },
      });

      await expectEvent(iterator, {
        streamPath: path,
        type: valueRecordedEventType,
        payload: { message: "read the env var" },
      });
      await expectEvent(iterator, {
        streamPath: path,
        type: envVarObservedEventType,
        payload: {
          key: "OPENAI_API_KEY",
          value: "plain-demo-key",
        },
      });
    } finally {
      await iterator.return?.();
    }
  });

  test("keeps getIterateSecret literal in process.env and resolves SDK-style auth headers at egress", async () => {
    const path = uniqueDynamicWorkerPath();
    const iterator = await openLiveIterator(path);
    const secretName = `dynamic-worker-env-${randomUUID().slice(0, 8)}`;
    const secretValue = `secret-${randomUUID().slice(0, 8)}`;
    const secret = await app.client.secrets.create({
      name: secretName,
      value: secretValue,
      description: "Temporary secret for dynamic worker env binding e2e",
    });

    try {
      await expectInitialized(iterator, path);
      await setDynamicWorkerEnvVar({
        path,
        key: "OPENAI_API_KEY",
        value: `getIterateSecret({secretKey: '${secretName}'})`,
      });
      await expectEvent(iterator, {
        streamPath: path,
        type: envVarSetEventType,
        payload: {
          key: "OPENAI_API_KEY",
          value: `getIterateSecret({secretKey: '${secretName}'})`,
        },
      });
      await configureWorker({
        path,
        slug: "env-egress",
        script: envVarEgressDynamicWorkerScript,
        outboundGateway: {
          entrypoint: "DynamicWorkerEgressGateway",
        },
      });
      await expectConfiguredEvent(iterator, path, "env-egress");

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "read the env var and fetch" },
      });

      await expectEvent(iterator, {
        streamPath: path,
        type: valueRecordedEventType,
      });
      await expectEvent(iterator, {
        streamPath: path,
        type: envVarObservedEventType,
        payload: {
          key: "OPENAI_API_KEY",
          value: `getIterateSecret({secretKey: '${secretName}'})`,
          authorization: `Bearer getIterateSecret({secretKey: '${secretName}'})`,
        },
      });
      await expectEvent(iterator, {
        streamPath: path,
        type: httpbinEchoedEventType,
        payload: {
          ok: true,
          normalizedHeaders: {
            authorization: `Bearer ${secretValue}`,
          },
        },
      });
    } finally {
      await app.client.secrets.remove({ id: secret.id });
      await iterator.return?.();
    }
  }, 30_000);
});

async function expectInitialized(iterator: AsyncIterator<unknown>, path: StreamPath) {
  await expectEvent(iterator, {
    streamPath: path,
    type: "https://events.iterate.com/events/stream/initialized",
  });
}

async function expectConfiguredEvent(
  iterator: AsyncIterator<unknown>,
  path: StreamPath,
  slug: string,
) {
  await expectEvent(iterator, {
    streamPath: path,
    type: configuredEventType,
    payload: {
      slug,
    },
  });
}

async function configureWorker(args: {
  path: StreamPath;
  slug: string;
  script: string;
  outboundGateway?: {
    entrypoint: "DynamicWorkerEgressGateway";
  };
}) {
  await append(args.path, {
    type: configuredEventType,
    payload: {
      slug: args.slug,
      script: args.script,
      ...(args.outboundGateway != null ? { outboundGateway: args.outboundGateway } : {}),
    },
  });
}

async function setDynamicWorkerEnvVar(args: { path: StreamPath; key: string; value: string }) {
  await append(args.path, {
    type: envVarSetEventType,
    payload: {
      key: args.key,
      value: args.value,
    },
  });
}

async function append(path: StreamPath, event: EventInput) {
  await app.append({
    streamPath: path,
    event,
  });
}

async function openLiveIterator(path: StreamPath) {
  const stream = await app.client.stream({
    path,
  });

  return stream[Symbol.asyncIterator]();
}

async function expectEvent(iterator: AsyncIterator<unknown>, expected: Record<string, unknown>) {
  expect(await readNextEvent(iterator)).toMatchObject(expected);
}

async function readNextEvent(iterator: AsyncIterator<unknown>) {
  const next = await Promise.race([
    iterator.next(),
    delay(nextEventTimeoutMs).then(() => {
      throw new Error("Timed out waiting for next dynamic worker event");
    }),
  ]);

  expect(next.done).toBe(false);
  return next.value;
}

async function expectEventCount(path: StreamPath, count: number) {
  await delay(idleEventTimeoutMs);
  expect((await app.client.getState({ path })).eventCount).toBe(count);
}

function uniqueDynamicWorkerPath() {
  const id = randomUUID().slice(0, 8);
  return `/dynamic-worker-e2e/${id}/stream` as StreamPath;
}
