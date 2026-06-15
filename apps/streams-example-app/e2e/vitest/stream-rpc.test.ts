import { describe, expect, it } from "vitest";
import {
  DEFAULT_STREAM_NAMESPACE,
  parseStreamRpcRequest,
  streamDurableObjectName,
  streamRpcPath,
} from "../../src/lib/stream-rpc.ts";

describe("stream RPC URL helpers", () => {
  it("builds default-namespace stream RPC paths from query params", () => {
    expect(streamRpcPath({ path: "/" })).toBe("/api/streams?path=%2F");
    expect(streamRpcPath({ path: "/e2e/foo" })).toBe("/api/streams?path=%2Fe2e%2Ffoo");
  });

  it("includes namespace in the query when it is not the default", () => {
    expect(streamRpcPath({ path: "/foo", namespace: "proj_123" })).toBe(
      "/api/streams?path=%2Ffoo&namespace=proj_123",
    );
  });

  it("parses stream RPC requests back into namespace and path", () => {
    const url = new URL("https://example.test/api/streams?path=%2Fe2e%2Ffoo&namespace=proj_123");
    expect(parseStreamRpcRequest({ url })).toEqual({
      namespace: "proj_123",
      path: "/e2e/foo",
    });
  });

  it("defaults omitted namespace to the example app namespace", () => {
    const url = new URL("https://example.test/api/streams?path=%2F");
    expect(parseStreamRpcRequest({ url })).toEqual({
      namespace: DEFAULT_STREAM_NAMESPACE,
      path: "/",
    });
  });

  it("builds durable object names from namespace and path", () => {
    expect(streamDurableObjectName({ namespace: "proj_123", path: "/foo" })).toBe("proj_123:/foo");
  });
});
