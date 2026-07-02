import { describe, expect, it } from "vitest";
import { DynamicWorkerRef } from "./schemas.ts";

const inlineSource = {
  mainModule: "worker.ts",
  modules: { "worker.ts": "export default {};" },
  type: "inline",
} as const;

describe("DynamicWorkerRef schema", () => {
  it("allows props on stateless entrypoint refs", () => {
    expect(
      DynamicWorkerRef.parse({
        path: "agents/alice",
        props: { answer: 42, nested: { ok: true } },
        source: inlineSource,
        type: "stateless",
      }),
    ).toMatchObject({
      path: "/agents/alice",
      props: { answer: 42, nested: { ok: true } },
      type: "stateless",
    });
  });

  it("rejects props on stateful durable worker refs", () => {
    expect(() =>
      DynamicWorkerRef.parse({
        className: "Counter",
        durableWorkerKey: "counter",
        path: "/agents/alice",
        props: { ignored: true },
        source: inlineSource,
        type: "stateful",
      }),
    ).toThrow();
  });
});
