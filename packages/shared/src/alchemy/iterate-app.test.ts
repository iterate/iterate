import { describe, expect, it } from "vitest";
import {
  planCloudflareDnsRecordReconciliation,
  selectBestCloudflareZoneForHostname,
} from "./iterate-app.ts";

describe("selectBestCloudflareZoneForHostname", () => {
  it("prefers an active delegated zone over a moved zone in the configured account", () => {
    expect(
      selectBestCloudflareZoneForHostname({
        accountId: "preview-account",
        hostname: "os.iterate-preview-2.com",
        zones: [
          {
            account: { id: "preview-account" },
            id: "moved-zone",
            name: "iterate-preview-2.com",
            status: "moved",
          },
          {
            account: { id: "delegated-account" },
            id: "active-zone",
            name: "iterate-preview-2.com",
            status: "active",
          },
        ],
      })?.id,
    ).toBe("active-zone");
  });

  it("still prefers an active zone in the configured account when one exists", () => {
    expect(
      selectBestCloudflareZoneForHostname({
        accountId: "preview-account",
        hostname: "*.iterate-preview-2.app",
        zones: [
          {
            account: { id: "other-account" },
            id: "other-active-zone",
            name: "iterate-preview-2.app",
            status: "active",
          },
          {
            account: { id: "preview-account" },
            id: "preview-active-zone",
            name: "iterate-preview-2.app",
            status: "active",
          },
        ],
      })?.id,
    ).toBe("preview-active-zone");
  });

  it("resolves catch-all worker route patterns to their zone", () => {
    expect(
      selectBestCloudflareZoneForHostname({
        accountId: "preview-account",
        hostname: "*iterate-preview-2.app",
        zones: [
          {
            account: { id: "preview-account" },
            id: "preview-active-zone",
            name: "iterate-preview-2.app",
            status: "active",
          },
        ],
      })?.id,
    ).toBe("preview-active-zone");
  });
});

describe("planCloudflareDnsRecordReconciliation", () => {
  it("repairs duplicate proxied A and AAAA records that point at Cloudflare edge IPs", () => {
    const existing = [
      {
        content: "104.21.16.175",
        id: "bad-a",
        name: "*.iterate-preview-2.app",
        proxied: true,
        type: "A",
      },
      {
        content: "172.67.214.229",
        id: "bad-b",
        name: "*.iterate-preview-2.app",
        proxied: true,
        type: "A",
      },
      {
        content: "2606:4700:3031::ac43:d6e5",
        id: "bad-aaaa-a",
        name: "*.iterate-preview-2.app",
        proxied: true,
        type: "AAAA",
      },
      {
        content: "2606:4700:3033::6815:10af",
        id: "bad-aaaa-b",
        name: "*.iterate-preview-2.app",
        proxied: true,
        type: "AAAA",
      },
    ];

    expect(
      planCloudflareDnsRecordReconciliation({
        desired: {
          comment: "managed",
          content: "192.0.2.1",
          name: "*.iterate-preview-2.app",
          proxied: true,
          ttl: 1,
          type: "A",
        },
        existing,
      }),
    ).toMatchObject({
      action: "upsert",
      deleteRecordIds: ["bad-b"],
      recordId: "bad-a",
    });

    expect(
      planCloudflareDnsRecordReconciliation({
        desired: {
          comment: "managed",
          content: "100::",
          name: "*.iterate-preview-2.app",
          proxied: true,
          ttl: 1,
          type: "AAAA",
        },
        existing,
      }),
    ).toMatchObject({
      action: "upsert",
      deleteRecordIds: ["bad-aaaa-b"],
      recordId: "bad-aaaa-a",
    });
  });

  it("leaves a proxied CNAME route record alone", () => {
    expect(
      planCloudflareDnsRecordReconciliation({
        desired: {
          comment: "managed",
          content: "192.0.2.1",
          name: "app.example.com",
          proxied: true,
          ttl: 1,
          type: "A",
        },
        existing: [
          {
            content: "worker.example.workers.dev",
            id: "cname",
            name: "app.example.com",
            proxied: true,
            type: "CNAME",
          },
        ],
      }),
    ).toMatchObject({ action: "keep" });
  });
});
