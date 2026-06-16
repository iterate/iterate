import { describe, expect, it } from "vitest";
import {
  DEFAULT_STREAM_PROJECT_ID,
  parseStreamRpcRequest,
  streamDurableObjectName,
  streamRpcPath,
} from "../../src/lib/stream-rpc.ts";

describe("stream RPC URL helpers", () => {
  it("builds default-projectId stream RPC paths from query params", () => {
    expect(streamRpcPath({ path: "/" })).toBe("/api/streams?path=%2F");
    expect(streamRpcPath({ path: "/e2e/foo" })).toBe("/api/streams?path=%2Fe2e%2Ffoo");
  });

  it("includes projectId in the query when it is not the default", () => {
    expect(streamRpcPath({ path: "/foo", projectId: "proj_123" })).toBe(
      "/api/streams?path=%2Ffoo&projectId=proj_123",
    );
  });

  it("parses stream RPC requests back into projectId and path", () => {
    const url = new URL("https://example.test/api/streams?path=%2Fe2e%2Ffoo&projectId=proj_123");
    expect(parseStreamRpcRequest({ url })).toEqual({
      projectId: "proj_123",
      path: "/e2e/foo",
    });
  });

  it("defaults omitted projectId to the example app projectId", () => {
    const url = new URL("https://example.test/api/streams?path=%2F");
    expect(parseStreamRpcRequest({ url })).toEqual({
      projectId: DEFAULT_STREAM_PROJECT_ID,
      path: "/",
    });
  });

  it("builds durable object names from projectId and path", () => {
    expect(streamDurableObjectName({ projectId: "proj_123", path: "/foo" })).toBe("proj_123:/foo");
  });
});
