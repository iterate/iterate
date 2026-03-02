import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { echoService } from "./echo-service.ts";

describe("echo service (HTTP proxy)", () => {
  let target: string;
  let close: () => void;

  beforeAll(async () => {
    const result = await echoService.start({});
    target = result.target;
    close = result.close;
  }, 10_000);

  afterAll(() => {
    close?.();
  });

  test("health endpoint responds via managed route", async () => {
    const res = await fetch(`http://${target}/service/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.slug).toBe("echo");
    expect(body.innerPort).toBeTypeOf("number");
  });

  test("openapi.json responds via managed route", async () => {
    const res = await fetch(`http://${target}/openapi.json`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openapi).toBe("3.0.0");
    expect(body.info.title).toBe("Echo HTTP Service");
  });

  test("non-managed path proxies through to inner echo server", async () => {
    const res = await fetch(`http://${target}/some/random/path`, {
      method: "POST",
      body: "hello world",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.echo).toBe(true);
    expect(body.method).toBe("POST");
    expect(body.url).toBe("/some/random/path");
    expect(body.body).toBe("hello world");
  });

  test("GET to non-managed path proxies correctly", async () => {
    const res = await fetch(`http://${target}/api/widgets?limit=10`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.echo).toBe(true);
    expect(body.method).toBe("GET");
    expect(body.url).toBe("/api/widgets?limit=10");
  });
});
