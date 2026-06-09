import { afterEach, describe, expect, test, vi } from "vitest";
import { dispatchFetchCallable } from "./host-routing.ts";

describe("dispatchFetchCallable", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("proxies HTTP requests to a base URL with configured headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

    const response = await dispatchFetchCallable({
      callable: {
        type: "fetch",
        via: {
          type: "url",
          url: "https://upstream.example.com",
        },
        fetchRequest: {
          headers: {
            "x-iterate-project-id": "proj_local_test",
          },
        },
      },
      context: {},
      request: new Request("https://api.demo.iterate.localhost/api/streams/foo?after=1", {
        headers: {
          accept: "application/json",
        },
      }),
    });

    expect(await response.text()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const proxyRequest = fetchMock.mock.calls[0]?.[0];
    expect(proxyRequest).toBeInstanceOf(Request);
    const request = proxyRequest as Request;
    expect(request.url).toBe("https://upstream.example.com/api/streams/foo?after=1");
    expect(request.headers.get("accept")).toBe("application/json");
    expect(request.headers.get("x-iterate-project-id")).toBe("proj_local_test");
  });
});
