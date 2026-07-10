import { describe, expect, it } from "vitest";
import { modeCapabilities, streamViewMode } from "./stream-view-search.ts";

describe("streamViewMode", () => {
  it("defaults agents to pretty and other streams to raw", () => {
    expect(streamViewMode({}, "/agents/x")).toBe("pretty");
    expect(streamViewMode({}, "/secrets/x")).toBe("raw");
  });

  it("clamps unsupported agent modes on non-agent streams to raw", () => {
    expect(streamViewMode({ mode: "pretty" }, "/secrets/x")).toBe("raw");
    expect(streamViewMode({ mode: "pretty-raw" }, "/repos/x")).toBe("raw");
    expect(streamViewMode({ mode: "pretty-debug" }, "/sandboxes")).toBe("raw");
  });

  it("normalizes legacy pretty-debug to pretty-raw on agents", () => {
    expect(streamViewMode({ mode: "pretty-debug" }, "/agents/x")).toBe("pretty-raw");
  });

  it("honors valid modes on agents", () => {
    expect(streamViewMode({ mode: "raw" }, "/agents/x")).toBe("raw");
    expect(streamViewMode({ mode: "pretty-raw" }, "/agents/x")).toBe("pretty-raw");
  });
});

describe("modeCapabilities", () => {
  it("keeps the raw rail visible when pretty-raw has legacy raw=false", () => {
    const caps = modeCapabilities({ mode: "pretty-raw", raw: false }, "/agents/x");
    expect(caps.agentFeed).toBe(true);
    expect(caps.rawFeed).toBe(true);
    expect(caps.eventInspector).toBe(true);
    expect(caps.rawEventTypes).toBe(false);
    expect(caps.rawComponents).toBe(false);
  });

  it("uses raw caps for non-agent streams even if mode=pretty is in the URL", () => {
    const caps = modeCapabilities({ mode: "pretty" }, "/secrets/x");
    expect(caps.agentFeed).toBe(false);
    expect(caps.rawFeed).toBe(true);
  });
});
