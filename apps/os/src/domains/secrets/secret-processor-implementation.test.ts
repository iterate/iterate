import { describe, expect, test } from "vitest";
import type { Stream } from "../../itx-api.generated.ts";
import type { StreamEvent } from "../streams/schemas.ts";
import { MemoryStreamNetwork } from "../streams/test-helpers.ts";
import { SecretProcessor } from "./secret-processor-implementation.ts";

const neverStream = new Proxy({} as Stream, {
  get(_target, property) {
    throw new Error(`Unexpected stream access: ${String(property)}`);
  },
});

function processor() {
  return new SecretProcessor({
    path: "/secrets/example",
    projectId: "prj_example",
    stream: neverStream,
  });
}

function updated(offset: number, payload: Record<string, unknown>): StreamEvent {
  return {
    createdAt: new Date(offset).toISOString(),
    offset,
    path: "/secrets/example",
    payload,
    type: "events.iterate.com/secret/updated",
  };
}

const encryptedMaterial = {
  algorithm: "AES-GCM-SHA256+SECRET-CELL-V1",
  ciphertext: "ciphertext",
  iv: "initialization-vector",
} as const;

describe("SecretProcessor material decisions", () => {
  test("throws when a second secret birth certificate is reduced", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/secrets/example");
    const subject = new SecretProcessor({
      path: stream.path,
      projectId: "prj_example",
      stream,
    });
    const birthCertificate = {
      config: { egress: { urls: ["https://api.example.com"] }, refresh: null },
    };
    await subject.ingest({
      events: [
        {
          createdAt: new Date(1).toISOString(),
          offset: 1,
          path: "/secrets/example",
          payload: birthCertificate,
          type: "events.iterate.com/secret/created",
        },
      ],
      streamMaxOffset: 1,
    });

    await expect(
      subject.ingest({
        events: [
          {
            createdAt: new Date(2).toISOString(),
            offset: 2,
            path: "/secrets/example",
            payload: birthCertificate,
            type: "events.iterate.com/secret/created",
          },
        ],
        streamMaxOffset: 2,
      }),
    ).rejects.toThrow("secret received more than one created event");
  });

  test("records the committed offset with material", async () => {
    const subject = processor();
    await subject.ingest({
      events: [
        updated(7, {
          egress: { urls: ["https://api.example.com"] },
          encryptedMaterial,
        }),
      ],
      streamMaxOffset: 7,
    });

    await expect(subject.snapshot()).resolves.toMatchObject({
      state: { encryptedMaterial: { ...encryptedMaterial, offset: 7 }, updatedOffset: 7 },
    });
  });
});
