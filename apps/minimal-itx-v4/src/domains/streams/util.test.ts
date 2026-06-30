import { describe, expect, it } from "vitest";
import { resolveStreamPath } from "./util.ts";

describe("stream utilities", () => {
  it("resolves child and sibling paths inside the held stream root", () => {
    expect(resolveStreamPath("/agents/demo", "messages")).toBe("/agents/demo/messages");
    expect(resolveStreamPath("/agents/demo/messages", "../events")).toBe("/agents/demo/events");
    expect(resolveStreamPath("/agents/demo", "/absolute")).toBe("/absolute");
    expect(resolveStreamPath("/agents/demo", ".")).toBe("/agents/demo");
  });

  it("rejects relative paths that escape the stream root", () => {
    expect(() => resolveStreamPath("/", "..")).toThrow(/escapes the stream root/);
  });
});
