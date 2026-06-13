import { describe, expect, it } from "vitest";
import type { StreamEvent } from "@iterate-com/streams/shared/event";
import { SecretProcessor, type SecretProcessorDeps } from "./implementation.ts";
import {
  encryptSecretMaterial,
  generateSecretsKeyBase64,
  importSecretsKey,
  type EncryptedMaterial,
} from "~/domains/secrets/secret-crypto.ts";

describe("SecretProcessor", () => {
  it("folds set → rotated → used → deleted, carrying only ciphertext", async () => {
    const { processor } = createProcessor();
    const encrypted = await encrypted_("token-v1");

    await processor.ingest({
      events: [
        committedEvent({
          offset: 1,
          type: "events.iterate.com/secret/set",
          payload: {
            slug: "github/access-token",
            encryptedMaterial: encrypted,
            metadata: { provider: "github" },
            tier: "project",
            source: { kind: "integration-connect", integration: "github" },
          },
        }),
      ],
      streamMaxOffset: 1,
    });
    expect(processor.state.status).toBe("set");
    expect(processor.state.version).toBe(1);
    expect(processor.state.encryptedMaterial).toEqual(encrypted);
    expect(JSON.stringify(processor.state)).not.toContain("token-v1");

    const rotated = await encrypted_("token-v2");
    await processor.ingest({
      events: [
        committedEvent({
          offset: 2,
          type: "events.iterate.com/secret/rotated",
          payload: {
            slug: "github/access-token",
            encryptedMaterial: rotated,
            reason: "oauth-refresh",
          },
        }),
        committedEvent({
          offset: 3,
          type: "events.iterate.com/secret/used",
          payload: {
            slug: "github/access-token",
            usedBy: "itx:integrations.github",
            usage: "reveal",
            at: "2026-06-11T00:00:00.000Z",
          },
        }),
      ],
      streamMaxOffset: 3,
    });
    expect(processor.state.version).toBe(2);
    expect(processor.state.encryptedMaterial).toEqual(rotated);
    expect(processor.state.audit).toEqual({
      uses: 1,
      lastUsedAt: "2026-06-11T00:00:00.000Z",
      lastUsedBy: "itx:integrations.github",
    });

    await processor.ingest({
      events: [
        committedEvent({
          offset: 4,
          type: "events.iterate.com/secret/deleted",
          payload: { slug: "github/access-token" },
        }),
      ],
      streamMaxOffset: 4,
    });
    expect(processor.state.status).toBe("deleted");
    expect(processor.state.encryptedMaterial).toBeUndefined();
  });

  it("tells the host DO to arm its refresh alarm when refreshable material lands", async () => {
    const armed: unknown[] = [];
    const { processor } = createProcessor({
      onRefreshableMaterial: (input) => {
        armed.push(input);
      },
    });

    await processor.ingest({
      events: [
        committedEvent({
          offset: 1,
          type: "events.iterate.com/secret/set",
          payload: {
            slug: "google/access-token",
            encryptedMaterial: await encrypted_("ya29.token"),
            expiresAt: "2026-06-11T01:00:00.000Z",
            // OAuth refresh expressed as the general derivation: the refresh
            // token and client secret are SOURCE secrets; the token endpoint
            // is just an http exchange.
            derivation: {
              kind: "http-exchange",
              request: {
                url: "https://oauth2.googleapis.com/token",
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body:
                  "grant_type=refresh_token" +
                  '&refresh_token=getSecret({ key: "google/refresh-token" })' +
                  "&client_id=client-id" +
                  '&client_secret=getSecret({ key: "google/oauth-client-secret" })',
              },
              extract: { materialPointer: "/access_token", expiresInPointer: "/expires_in" },
              refreshLeewaySeconds: 300,
            },
          },
        }),
      ],
      streamMaxOffset: 1,
    });
    await flushBackgroundWork();

    expect(armed).toEqual([{ expiresAt: "2026-06-11T01:00:00.000Z", refreshLeewaySeconds: 300 }]);
  });
});

describe("SecretProcessor derivation (the logic lives in the processor)", () => {
  it("reacts to derive-requested by running the exchange and appending rotated", async () => {
    const exchanges: string[] = [];
    const { appended, processor } = createProcessor({
      encryptMaterial: async (material) => await encrypted_(material),
      resolveSecretKey: async (key) => `material-of-${key}`,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        exchanges.push(String(init?.body));
        return Response.json({ data: { generateSession: { accessToken: "session-1" } } });
      }) as typeof fetch,
    });

    await processor.ingest({
      events: [
        committedEvent({
          offset: 1,
          type: "events.iterate.com/secret/set",
          payload: {
            slug: "waitrose/default/access-token",
            derivation: {
              kind: "http-exchange",
              request: {
                url: "https://www.waitrose.com/api/graphql-prod/graph/live",
                method: "POST",
                body: 'u=getSecret({ key: "waitrose/default/username" })',
              },
              extract: {
                materialPointer: "/data/generateSession/accessToken",
                ttlSeconds: 300,
              },
              refreshLeewaySeconds: 30,
            },
          },
        }),
        committedEvent({
          offset: 2,
          type: "events.iterate.com/secret/derive-requested",
          payload: {
            slug: "waitrose/default/access-token",
            staleVersion: 0,
            reason: "inline-refresh",
          },
        }),
      ],
      streamMaxOffset: 2,
    });

    // Source secrets resolved through the host dep; exchange ran once.
    expect(exchanges).toEqual(["u=material-of-waitrose/default/username"]);
    expect(appended).toHaveLength(1);
    const rotated = appended[0]!.event as {
      type: string;
      idempotencyKey: string;
      payload: { slug: string; expiresAt?: string };
    };
    expect(rotated.type).toBe("events.iterate.com/secret/rotated");
    expect(rotated.idempotencyKey).toBe("secret/derive@2");
    expect(rotated.payload.slug).toBe("waitrose/default/access-token");
    expect(rotated.payload.expiresAt).toBeDefined();
  });

  it("skips requests the fold already satisfied (the concurrent-staleness gate)", async () => {
    const { appended, processor } = createProcessor({
      encryptMaterial: async (material) => await encrypted_(material),
      resolveSecretKey: async () => "unused",
      fetchImpl: (async () => {
        throw new Error("must not derive");
      }) as typeof fetch,
    });

    await processor.ingest({
      events: [
        committedEvent({
          offset: 1,
          type: "events.iterate.com/secret/set",
          payload: {
            slug: "s",
            encryptedMaterial: await encrypted_("fresh"),
            derivation: {
              kind: "http-exchange",
              request: { url: "https://example.com", method: "POST" },
              extract: { materialPointer: "/t" },
              refreshLeewaySeconds: 30,
            },
          },
        }),
        // A request raised against version 0 — but version is already 1.
        committedEvent({
          offset: 2,
          type: "events.iterate.com/secret/derive-requested",
          payload: { slug: "s", staleVersion: 0, reason: "inline-refresh" },
        }),
      ],
      streamMaxOffset: 2,
    });

    expect(appended).toEqual([]);
  });
});

async function encrypted_(material: string): Promise<EncryptedMaterial> {
  const key = await importSecretsKey(generateSecretsKeyBase64());
  return await encryptSecretMaterial({ key, material });
}

function createProcessor(deps: SecretProcessorDeps = {}) {
  const appended: Array<{ streamPath?: string; event: unknown }> = [];
  const processor = new SecretProcessor({
    iterateContext: {
      stream: {
        append: async ({ event, streamPath }) => {
          appended.push({ event, streamPath });
          return committedEvent({ ...event, offset: appended.length });
        },
        appendBatch: async ({ events, streamPath }) =>
          events.map((event) => {
            appended.push({ event, streamPath });
            return committedEvent({ ...event, offset: appended.length });
          }),
      },
    },
    ...deps,
  });
  return { appended, processor };
}

async function flushBackgroundWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
    createdAt: "2026-06-11T00:00:00.000Z",
  };
}
