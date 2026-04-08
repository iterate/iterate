/**
 * Real-network runtime checks for dynamic workers that fetch through an outbound gateway.
 * Set `EVENTS_BASE_URL` before running the suite.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { type Event, type EventInput, type StreamPath } from "@iterate-com/events-contract";
import { httpbinEchoDynamicWorkerScript } from "../../src/durable-objects/dynamic-processor.ts";
import {
  collectAsyncIterableUntilIdle,
  createEvents2AppFixture,
  requireEventsBaseUrl,
} from "../helpers.ts";

const app = createEvents2AppFixture({
  baseURL: requireEventsBaseUrl(),
});
const configuredEventType = "https://events.iterate.com/events/stream/dynamic-worker/configured";
const httpbinEchoedEventType = "https://events.iterate.com/events/example/httpbin-echoed";
const valueRecordedEventType = "https://events.iterate.com/events/example/value-recorded";

describe("dynamic worker outbound gateway", () => {
  test("fetches through the egress worker and appends the echoed secret header", async () => {
    const path = uniquePath();
    const secretHeaderName = "x-dynamic-worker-secret";
    const secretHeaderValue = `secret-${randomUUID().slice(0, 8)}`;

    await configureEchoWorker({
      path,
      secretHeaderName,
      secretHeaderValue,
      slug: "httpbin-echo",
    });
    await append(path, {
      type: valueRecordedEventType,
      payload: { message: "please ping the echo gateway" },
    });

    const echoed = await waitForEchoEvent(path, 1);

    expect(echoed.payload).toMatchObject({
      ok: true,
      status: 200,
      normalizedHeaders: {
        [secretHeaderName]: secretHeaderValue,
      },
      response: {
        headers: {
          "X-Dynamic-Worker-Secret": secretHeaderValue,
        },
      },
    });
  }, 30_000);

  test("resolves getIterateSecret in the configured injected header from apps/events secrets", async () => {
    const path = uniquePath();
    const secretHeaderName = "x-dynamic-worker-secret";
    const secretName = `dynamic-worker-egress-${randomUUID().slice(0, 8)}`;
    const secretHeaderValue = `secret-${randomUUID().slice(0, 8)}`;
    const secret = await app.client.secrets.create({
      name: secretName,
      value: secretHeaderValue,
      description: "Temporary secret for dynamic-worker egress substitution test",
    });

    try {
      await configureEchoWorker({
        path,
        secretHeaderName,
        secretHeaderValue: `getIterateSecret({secretKey: '${secretName}'})`,
        slug: "httpbin-echo",
      });
      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "please ping the echo gateway" },
      });

      const echoed = await waitForEchoEvent(path, 1);

      expect(echoed.payload.normalizedHeaders[secretHeaderName]).toBe(secretHeaderValue);
      expect(
        (echoed.payload.response as { headers: Record<string, string> }).headers[
          "X-Dynamic-Worker-Secret"
        ],
      ).toBe(secretHeaderValue);
    } finally {
      await app.client.secrets.remove({ id: secret.id });
    }
  }, 30_000);

  test("resolves getIterateSecret in headers created by the dynamic worker fetch call itself", async () => {
    const path = uniquePath();
    const secretName = `dynamic-worker-egress-${randomUUID().slice(0, 8)}`;
    const secretHeaderValue = `Bearer secret-${randomUUID().slice(0, 8)}`;
    const secret = await app.client.secrets.create({
      name: secretName,
      value: secretHeaderValue,
      description: "Temporary secret for dynamic-worker header substitution test",
    });

    try {
      await append(path, {
        type: configuredEventType,
        payload: {
          slug: "httpbin-fetch-header",
          script: `
export default {
  slug: "httpbin-fetch-header",
  initialState: {},

  reduce({ state }) {
    return state;
  },

  async afterAppend({ append, event }) {
    if (!/\\bping\\b/i.test(JSON.stringify(event))) {
      return;
    }

    const response = await fetch("https://httpbin.org/headers", {
      headers: {
        authorization: "getIterateSecret({secretKey: '${secretName}'})",
      },
    });
    const responseJson = await response.json();

    await append({
      event: {
        type: "https://events.iterate.com/events/example/httpbin-echoed",
        payload: {
          ok: response.ok,
          status: response.status,
          normalizedHeaders: Object.fromEntries(
            Object.entries(responseJson.headers ?? {}).map(([key, value]) => [
              String(key).toLowerCase(),
              value,
            ]),
          ),
          response: responseJson,
        },
      },
    });
  },
};
          `.trim(),
          outboundGateway: {
            entrypoint: "DynamicWorkerEgressGateway",
          },
        },
      });
      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "please ping the echo gateway" },
      });

      const echoed = await waitForEchoEvent(path, 1);
      expect(echoed.payload.normalizedHeaders.authorization).toBe(secretHeaderValue);
    } finally {
      await app.client.secrets.remove({ id: secret.id });
    }
  }, 30_000);

  test("hot-swapping the outbound gateway secret changes the echoed header", async () => {
    const path = uniquePath();
    const secretHeaderName = "x-dynamic-worker-secret";
    const firstSecret = `first-${randomUUID().slice(0, 6)}`;
    const secondSecret = `second-${randomUUID().slice(0, 6)}`;

    await configureEchoWorker({
      path,
      secretHeaderName,
      secretHeaderValue: firstSecret,
      slug: "httpbin-echo",
    });
    await append(path, {
      type: valueRecordedEventType,
      payload: { message: "ping with the first secret" },
    });

    const firstEcho = await waitForEchoEvent(path, 1);
    expect(firstEcho.payload.normalizedHeaders[secretHeaderName]).toBe(firstSecret);

    await configureEchoWorker({
      path,
      secretHeaderName,
      secretHeaderValue: secondSecret,
      slug: "httpbin-echo",
    });
    await append(path, {
      type: valueRecordedEventType,
      payload: { message: "ping with the second secret" },
    });

    const secondEcho = await waitForEchoEvent(path, 2);
    expect(secondEcho.payload.normalizedHeaders[secretHeaderName]).toBe(secondSecret);
  }, 45_000);
});

async function configureEchoWorker(args: {
  path: StreamPath;
  secretHeaderName: string;
  secretHeaderValue: string;
  slug: string;
}) {
  await append(args.path, {
    type: configuredEventType,
    payload: {
      slug: args.slug,
      script: httpbinEchoDynamicWorkerScript,
      outboundGateway: {
        entrypoint: "DynamicWorkerEgressGateway",
        props: {
          secretHeaderName: args.secretHeaderName,
          secretHeaderValue: args.secretHeaderValue,
        },
      },
    },
  });
}

async function append(path: StreamPath, event: EventInput) {
  await app.append({
    streamPath: path,
    event,
  });
}

async function waitForEchoEvent(path: StreamPath, ordinal: number) {
  const deadline = Date.now() + 30_000;
  let lastEvents: Event[] = [];

  while (Date.now() < deadline) {
    lastEvents = await readHistory(path);
    const echoed = lastEvents.filter((event) => event.type === httpbinEchoedEventType);

    if (echoed.length >= ordinal) {
      return echoed[ordinal - 1] as Event & {
        payload: {
          normalizedHeaders: Record<string, string>;
          ok: boolean;
          response: Record<string, unknown>;
          status: number;
        };
      };
    }

    await delay(500);
  }

  throw new Error(
    `Timed out waiting for ${ordinal} ${httpbinEchoedEventType} events; last history was ${lastEvents
      .map((event) => event.type)
      .join(", ")}`,
  );
}

async function readHistory(path: StreamPath) {
  return (await collectAsyncIterableUntilIdle({
    iterable: await app.client.stream({ path, before: "end" }),
    idleMs: 500,
  })) as Event[];
}

function uniquePath() {
  return `/dynamic-worker-egress/${randomUUID().slice(0, 8)}/stream` as StreamPath;
}
