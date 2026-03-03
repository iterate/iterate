import { describe, expect, test } from "vitest";
import {
  createProxyRequestTransform,
  createProxyWebSocketUrlTransform,
} from "./proxy-request-transform.ts";

describe("createProxyRequestTransform", () => {
  test("rewrites HTTP request using x-forwarded headers", () => {
    const transform = createProxyRequestTransform();
    const request = new Request("http://127.0.0.1:9000/v1/models?x=1", {
      headers: {
        "x-forwarded-host": "api.example.com",
        "x-forwarded-proto": "https",
      },
    });

    const transformed = transform(request);
    expect(transformed.url).toBe("https://api.example.com/v1/models?x=1");
    expect(transformed.headers.get("host")).toBe("api.example.com");
    expect(transformed.headers.get("x-forwarded-host")).toBeNull();
    expect(transformed.headers.get("x-forwarded-proto")).toBeNull();
  });

  test("does not use non-standard proxy hint headers", () => {
    const transform = createProxyRequestTransform();
    const request = new Request("http://127.0.0.1:9000/v1/models?x=1", {
      headers: {
        "proxy-target-host": "api.example.com",
        "proxy-target-proto": "https",
      },
    });

    const transformed = transform(request);
    expect(new URL(transformed.url).host).toBe("127.0.0.1:9000");
  });

  test("accepts x-forwarded-proto values with trailing colon", () => {
    const transform = createProxyRequestTransform();
    const request = new Request("http://127.0.0.1:9000/v1/models", {
      headers: {
        "x-forwarded-host": "api.example.com",
        "x-forwarded-proto": "https:",
      },
    });

    const transformed = transform(request);
    expect(transformed.url).toBe("https://api.example.com/v1/models");
  });
});

describe("createProxyWebSocketUrlTransform", () => {
  test("rewrites websocket URL using x-forwarded headers", () => {
    const transform = createProxyWebSocketUrlTransform();
    const transformed = transform(
      new URL("ws://127.0.0.1:9000/realtime"),
      new Headers({
        "x-forwarded-host": "external.example.com",
        "x-forwarded-proto": "https",
      }),
    );
    expect(transformed.toString()).toBe("wss://external.example.com/realtime");
  });

  test("defaults websocket URL scheme to ws for loopback hosts without x-forwarded-proto", () => {
    const transform = createProxyWebSocketUrlTransform();
    const transformed = transform(
      new URL("ws://127.0.0.1:9000/realtime"),
      new Headers({
        host: "127.0.0.1:9001",
      }),
    );
    expect(transformed.toString()).toBe("ws://127.0.0.1:9001/realtime");
  });

  test("defaults websocket URL scheme to wss for external hosts without x-forwarded-proto", () => {
    const transform = createProxyWebSocketUrlTransform();
    const transformed = transform(
      new URL("ws://127.0.0.1:9000/realtime"),
      new Headers({
        host: "api.openai.com",
      }),
    );
    expect(transformed.toString()).toBe("wss://api.openai.com/realtime");
  });
});
