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

  it("pages a byte-capped filtered window through its short nonempty pages", async () => {
    const stream = new MemoryStream();
    const [first, ignored, second] = await stream.append(
      { type: "test/match", payload: { body: "a".repeat(100) } },
      { type: "test/ignored", payload: { body: "b".repeat(100) } },
      { type: "test/match", payload: { body: "c".repeat(100) } },
    );
    const byteLimit = new TextEncoder().encode(JSON.stringify(first)).byteLength;

    using pager = stream.readEvents({
      afterOffset: 0,
      beforeOffset: second.offset + 1,
      byteLimit,
      eventTypes: ["test/match"],
      limit: 500,
    });
    await expect(pager.next()).resolves.toEqual([first]);
    await expect(pager.next()).resolves.toEqual([second]);
    await expect(pager.next()).resolves.toEqual([]);
    expect(ignored.offset).toBeLessThan(second.offset);
  });
});
