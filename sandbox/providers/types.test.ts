import { afterEach, describe, expect, it, vi } from "vitest";
import { Sandbox, type ProviderState } from "./types.ts";

class TestSandbox extends Sandbox {
  readonly providerId = "test-sandbox";
  readonly type = "docker" as const;
  requestedPorts: number[] = [];

  async getBaseUrl(opts: { port: number }): Promise<string> {
    this.requestedPorts.push(opts.port);
    return `http://sandbox.local:${opts.port}`;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async restart(): Promise<void> {}
  async delete(): Promise<void> {}
  async exec(_cmd: string[]): Promise<string> {
    return "";
  }
  async getState(): Promise<ProviderState> {
    return { state: "started" };
  }
}

describe("Sandbox.getFetcher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes through ingress port 8080 and sets localhost target header", async () => {
    const sandbox = new TestSandbox();
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);

    const fetcher = await sandbox.getFetcher({ port: 3003 });
    await fetcher("/api/trpc?batch=1", {
      headers: { "x-test": "yes" },
    });

    expect(sandbox.requestedPorts).toEqual([8080]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://sandbox.local:8080/api/trpc?batch=1",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );

    const init = fetchSpy.mock.calls[0]?.[1];
    if (!init) throw new Error("expected fetch init");
    const headers = new Headers(init.headers);
    expect(headers.get("x-test")).toBe("yes");
    expect(headers.get("x-iterate-proxy-target-host")).toBe("localhost:3003");
  });

  it("preserves caller-provided target header", async () => {
    const sandbox = new TestSandbox();
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);

    const fetcher = await sandbox.getFetcher({ port: 3003 });
    await fetcher("/api/webhook", {
      headers: {
        "x-iterate-proxy-target-host": "hello.iterate.app",
      },
    });

    const init = fetchSpy.mock.calls[0]?.[1];
    if (!init) throw new Error("expected fetch init");
    const headers = new Headers(init.headers);
    expect(headers.get("x-iterate-proxy-target-host")).toBe("hello.iterate.app");
  });

  it("rewrites absolute urls to ingress origin while preserving path/query", async () => {
    const sandbox = new TestSandbox();
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);

    const fetcher = await sandbox.getFetcher({ port: 4096 });
    await fetcher("http://example.invalid:3000/socket?token=abc");

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://sandbox.local:8080/socket?token=abc",
      expect.any(Object),
    );
  });

  it("forwards Request inputs as Request objects with rewritten url and merged headers", async () => {
    const sandbox = new TestSandbox();
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);

    const fetcher = await sandbox.getFetcher({ port: 3000 });
    await fetcher(
      new Request("https://origin.invalid/api/pty/ws?ptyId=123", {
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Key": "abc",
          "Sec-WebSocket-Version": "13",
        },
      }),
      {
        headers: {
          Origin: "https://origin.invalid",
        },
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [requestArg, initArg] = fetchSpy.mock.calls[0] ?? [];
    expect(requestArg).toBeInstanceOf(Request);
    expect(initArg).toBeUndefined();

    const request = requestArg as Request;
    expect(request.url).toBe("http://sandbox.local:8080/api/pty/ws?ptyId=123");
    expect(request.headers.get("upgrade")).toBe("websocket");
    expect(request.headers.get("connection")).toBe("Upgrade");
    expect(request.headers.get("origin")).toBe("https://origin.invalid");
    expect(request.headers.get("x-iterate-proxy-target-host")).toBe("localhost:3000");
  });
});
