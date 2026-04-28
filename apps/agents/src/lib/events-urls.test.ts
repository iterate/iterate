import { describe, expect, test } from "vitest";
import { buildAgentWebSocketCallbackUrl, workerReachableLocalUrl } from "./events-urls.ts";

describe("workerReachableLocalUrl", () => {
  test("rewrites localhost HTTP URLs to IPv6 loopback for workerd fetches", () => {
    expect(workerReachableLocalUrl("http://localhost:5173/api/openapi.json")).toBe(
      "http://[::1]:5173/api/openapi.json",
    );
    expect(workerReachableLocalUrl("http://127.0.0.1:5173/api/openapi.json")).toBe(
      "http://[::1]:5173/api/openapi.json",
    );
  });

  test("leaves remote URLs untouched", () => {
    expect(workerReachableLocalUrl("https://events.iterate.com/api/openapi.json")).toBe(
      "https://events.iterate.com/api/openapi.json",
    );
  });
});

describe("buildAgentWebSocketCallbackUrl", () => {
  test("uses a workerd-reachable loopback host for local websocket callbacks", () => {
    expect(
      buildAgentWebSocketCallbackUrl({
        publicOrigin: "http://localhost:5174",
        agentClass: "iterate-agent",
        agentInstance: "stream-demo",
      }),
    ).toBe("ws://[::1]:5174/agents/iterate-agent/stream-demo");
  });
});
