import { describe, expect, test } from "vitest";
import {
  computeSecWebSocketAccept,
  downstreamHandshakeHeaders,
  withWebSocketHandshakeHeaders,
} from "./websocket-handshake.ts";

describe("computeSecWebSocketAccept", () => {
  test("matches RFC 6455 example key", async () => {
    // RFC 6455 §1.3 / §4.2.2 example.
    await expect(computeSecWebSocketAccept("dGhlIHNhbXBsZSBub25jZQ==")).resolves.toBe(
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    );
  });
});

describe("withWebSocketHandshakeHeaders", () => {
  test.skipIf(typeof WebSocketPair === "undefined")(
    "stamps Accept for the caller key and strips hop-by-hop duplicates",
    async () => {
      const pair = new WebSocketPair();
      const request = new Request("https://example.com/ws", {
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
      // Upstream Accept is for a different key — must be replaced; Upgrade/
      // Connection are stripped so intercept can inject them once.
      const source = new Response(null, {
        status: 101,
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Accept": "wrong-accept-for-upstream-key",
        },
        webSocket: pair[0],
      });

      const stamped = await withWebSocketHandshakeHeaders(request, source);
      expect(stamped.status).toBe(101);
      expect(stamped.headers.get("Upgrade")).toBeNull();
      expect(stamped.headers.get("Connection")).toBeNull();
      expect(stamped.headers.get("Sec-WebSocket-Accept")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
      expect(stamped.webSocket).toBeTruthy();
    },
  );

  test("leaves non-websocket responses alone", async () => {
    const request = new Request("https://example.com");
    const response = new Response("ok");
    expect(await withWebSocketHandshakeHeaders(request, response)).toBe(response);
  });
});

describe("downstreamHandshakeHeaders", () => {
  test("reconstructs hop-specific fields and preserves an offered selected protocol", async () => {
    const request = new Request("https://example.com/ws", {
      headers: {
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Protocol": "chat, responses",
      },
    });
    const source = new Headers({
      Connection: "Upgrade",
      Location: "https://credential.example/secret-path",
      "Sec-WebSocket-Accept": "upstream-key-accept",
      "Sec-WebSocket-Extensions": "permessage-deflate",
      "Sec-WebSocket-Protocol": "responses",
      Upgrade: "websocket",
      "X-Upstream": "kept",
    });

    const headers = await downstreamHandshakeHeaders(request, source);
    expect(headers.get("connection")).toBeNull();
    expect(headers.get("location")).toBeNull();
    expect(headers.get("sec-websocket-extensions")).toBeNull();
    expect(headers.get("sec-websocket-accept")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    expect(headers.get("sec-websocket-protocol")).toBe("responses");
    expect(headers.get("upgrade")).toBeNull();
    expect(headers.get("x-upstream")).toBe("kept");
  });

  test("never invents a subprotocol or forwards an unoffered substituted value", async () => {
    const request = new Request("https://example.com/ws", {
      headers: {
        "Sec-WebSocket-Protocol": 'getSecret({ path: "/secrets/token" })',
      },
    });
    const noSelection = await downstreamHandshakeHeaders(request, new Headers());
    expect(noSelection.get("sec-websocket-protocol")).toBeNull();

    const secretSelection = await downstreamHandshakeHeaders(
      request,
      new Headers({ "Sec-WebSocket-Protocol": "real-secret-value" }),
    );
    expect(secretSelection.get("sec-websocket-protocol")).toBeNull();
  });

  test("replaces an upstream Accept derived from a substituted secret key", async () => {
    const request = new Request("https://example.com/ws", {
      headers: {
        "Sec-WebSocket-Key": 'getSecret({ path: "/secrets/token" })',
      },
    });
    const secretDerivedAccept = await computeSecWebSocketAccept("real-secret-value");

    const headers = await downstreamHandshakeHeaders(
      request,
      new Headers({ "Sec-WebSocket-Accept": secretDerivedAccept }),
    );

    expect(headers.get("sec-websocket-accept")).not.toBe(secretDerivedAccept);
    expect(headers.get("sec-websocket-accept")).toBe(
      await computeSecWebSocketAccept('getSecret({ path: "/secrets/token" })'),
    );
  });
});
