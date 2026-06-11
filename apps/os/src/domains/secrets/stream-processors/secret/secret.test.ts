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

async function encrypted_(material: string): Promise<EncryptedMaterial> {
  const key = await importSecretsKey(generateSecretsKeyBase64());
  return await encryptSecretMaterial({ key, material });
}

function createProcessor(deps: SecretProcessorDeps = {}) {
  const processor = new SecretProcessor({
    iterateContext: {
      stream: {
        append: async ({ event }) => committedEvent({ ...event, offset: 0 }),
        appendBatch: async ({ events }) =>
          events.map((event) => committedEvent({ ...event, offset: 0 })),
      },
    },
    ...deps,
  });
  return { processor };
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
