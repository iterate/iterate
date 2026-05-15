import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectWildcardCNAMERecord } from "./cloudflare-dns.ts";

describe("project Cloudflare DNS provisioning", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies the existing proxied wildcard DNS record type for project wildcards", async () => {
    const requests: Array<{ body?: unknown; method: string; url: string }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({
          body: init?.body == null ? undefined : JSON.parse(String(init.body)),
          method: init?.method ?? "GET",
          url,
        });

        if (url.includes("/zones?")) {
          return jsonResponse({
            result: [{ id: "zone_123", name: "iterate2.app", status: "active" }],
            success: true,
          });
        }

        if (url.includes("/dns_records?")) {
          return jsonResponse({
            result: [
              {
                content: "192.0.2.1",
                id: "source_record",
                name: "*.iterate2.app",
                proxied: true,
                ttl: 1,
                type: "A",
              },
            ],
            success: true,
          });
        }

        return jsonResponse({
          result: {
            ...(init?.body == null ? {} : JSON.parse(String(init.body))),
            id: "target_record",
          },
          success: true,
        });
      }),
    );

    const result = await createProjectWildcardCNAMERecord({
      apiToken: "token",
      projectHostnameBase: "iterate2.app",
      projectId: "proj_123",
      projectSlug: "demo",
    });

    const createRequest = requests.find((request) => request.method === "POST");
    expect(createRequest?.body).toMatchObject({
      content: "192.0.2.1",
      name: "*.demo.iterate2.app",
      proxied: true,
      ttl: 1,
      type: "A",
    });
    expect(result?.record.type).toBe("A");
    expect(result?.target).toBe("192.0.2.1");
  });
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}
