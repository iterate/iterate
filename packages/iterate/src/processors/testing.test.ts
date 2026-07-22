import { describe, expect, it } from "vitest";
import { MemoryStream } from "./testing.ts";

describe("MemoryStream", () => {
  it("detaches append bodies at the JSON boundary and rejects cycles", async () => {
    const stream = new MemoryStream();
    const payload = { nested: { value: 1 } };
    const metadata = { tag: "before" };
    const [event] = await stream.append({ type: "test/event", payload, metadata });

    payload.nested.value = 2;
    metadata.tag = "after";
    expect(event).toMatchObject({
      payload: { nested: { value: 1 } },
      metadata: { tag: "before" },
    });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(stream.append({ type: "test/cyclic", payload: cyclic })).rejects.toThrow();
  });
});
