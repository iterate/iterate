import { buildForwardedHeader, parseForwardedHeader } from "@iterate-com/shared/forwarded-header";
import { describe, expect, test } from "vitest";
import {
  createProxyRequestTransform,
  createProxyWebSocketUrlTransform,
} from "./proxy-request-transform.ts";

describe("forwarded-header shared utility", () => {
  test("builds canonical forwarded header", () => {
    const value = buildForwardedHeader({
      for: "203.0.113.42",
      host: "external.example.com",
      proto: "https:",
    });
    expect(value).toBe("for=203.0.113.42; host=external.example.com; proto=https");
  });

  test("omits for when unavailable", () => {
    const value = buildForwardedHeader({
      host: "external.example.com",
      proto: "https",
    });
    expect(value).toBe("host=external.example.com; proto=https");
  });

  test("parses first forwarded entry", () => {
    const parsed = parseForwardedHeader(
      "for=203.0.113.42; host=external.example.com; proto=https, for=10.0.0.1; host=ignored.test",
    );
    expect(parsed).toEqual({
      for: "203.0.113.42",
      host: "external.example.com",
      proto: "https",
    });
  });
});

describe("createProxyRequestTransform", () => {
  test("rewrites HTTP request using forwarded header only", () => {
    const transform = createProxyRequestTransform();
    const request = new Request("http://127.0.0.1:9000/v1/models?x=1", {
      headers: {
        forwarded: "for=203.0.113.42; host=api.example.com; proto=https",
      },
    });

    const transformed = transform(request);
    expect(transformed.url).toBe("https://api.example.com/v1/models?x=1");
    expect(transformed.headers.get("host")).toBe("api.example.com");
    expect(transformed.headers.get("forwarded")).toBeNull();
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
});

describe("createProxyWebSocketUrlTransform", () => {
  test("rewrites websocket URL using forwarded header", () => {
    const transform = createProxyWebSocketUrlTransform();
    const transformed = transform(
      new URL("ws://127.0.0.1:9000/realtime"),
      new Headers({
        forwarded: "for=203.0.113.42; host=external.example.com; proto=https",
      }),
    );
    expect(transformed.toString()).toBe("wss://external.example.com/realtime");
  });
});
