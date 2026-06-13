// The connect choreography is PROCESSOR logic: one connect-requested event
// in, the whole reaction out — secret/set cross-path appends, the connected
// fact, routing-key claims through the host dep.

import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamEventInput } from "@iterate-com/streams/shared/event";
import { IntegrationProcessor, type IntegrationProcessorDeps } from "./implementation.ts";

describe("IntegrationProcessor connect choreography", () => {
  it("reacts to connect-requested with secret/set appends, the connected fact, and route claims", async () => {
    const { appended, claimed, ensuredSecretHosts, processor } = createProcessor();

    await processor.ingest({
      events: [
        committedEvent({
          offset: 5,
          type: "events.iterate.com/integration/connect-requested",
          payload: {
            integration: "github",
            account: "work-org",
            projectId: "proj-a",
            ownership: "first-party",
            externalId: "installation-1234",
            displayName: "Acme Org",
            routingKeys: ["installation:1234"],
            secrets: [
              {
                name: "access-token",
                encryptedMaterial: { envelope: "aes-256-gcm.v1", iv: "aW0=", ciphertext: "Y3Q=" },
              },
            ],
          },
        }),
      ],
      streamMaxOffset: 5,
    });

    // 1. The credential cross-posted to its own /secrets stream, encrypted.
    const secretSet = appended.find((entry) => entry.streamPath != null);
    expect(secretSet).toMatchObject({
      streamPath: "/secrets/github/work-org/access-token",
      event: {
        type: "events.iterate.com/secret/set",
        idempotencyKey: "integration/connect-secret-access-token@5",
        payload: {
          slug: "github/work-org/access-token",
          encryptedMaterial: { envelope: "aes-256-gcm.v1", iv: "aW0=", ciphertext: "Y3Q=" },
          source: { kind: "integration-connect", integration: "github", account: "work-org" },
        },
      },
    });
    expect(ensuredSecretHosts).toEqual(["github/work-org/access-token"]);

    // 2. The connected fact on the account's own stream, folding into state.
    const connected = appended.find(
      (entry) =>
        entry.streamPath == null &&
        (entry.event as { type: string }).type === "events.iterate.com/integration/connected",
    );
    expect(connected).toMatchObject({
      event: {
        idempotencyKey: "integration/connected@5",
        payload: {
          integration: "github",
          account: "work-org",
          ownership: "first-party",
          externalId: "installation-1234",
          providedSecretSlugs: ["github/work-org/access-token"],
        },
      },
    });

    // 3. The routing claim through the host dep (cross-namespace).
    expect(claimed).toEqual(["installation:1234"]);
  });
});

function createProcessor(deps: Partial<IntegrationProcessorDeps> = {}) {
  const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
  const claimed: string[] = [];
  const ensuredSecretHosts: string[] = [];
  const processor = new IntegrationProcessor({
    iterateContext: {
      stream: {
        append: async ({ event, streamPath }) => {
          appended.push({ event, streamPath });
          return committedEvent({ ...event, offset: appended.length + 100 });
        },
        appendBatch: async ({ events, streamPath }) =>
          events.map((event) => {
            appended.push({ event, streamPath });
            return committedEvent({ ...event, offset: appended.length + 100 });
          }),
      },
    },
    claimRoute: async ({ routingKey }) => {
      claimed.push(routingKey);
    },
    ensureSecretHost: async ({ slug }) => {
      ensuredSecretHosts.push(slug);
    },
    ...deps,
  });
  return { appended, claimed, ensuredSecretHosts, processor };
}

function committedEvent(args: {
  type: string;
  payload?: unknown;
  idempotencyKey?: string;
  offset: number;
}): StreamEvent {
  return {
    type: args.type,
    payload: args.payload,
    ...(args.idempotencyKey == null ? {} : { idempotencyKey: args.idempotencyKey }),
    offset: args.offset,
    createdAt: "2026-06-12T00:00:00.000Z",
  };
}
