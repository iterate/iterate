import { describe, expect, test } from "vitest";
import type { Stream } from "../../itx-api.generated.ts";
import type { StreamEvent } from "../streams/schemas.ts";
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
