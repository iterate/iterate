import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDnsRecordBody,
  buildIngressConfig,
  countMissingResources,
  pickUnusedSlug,
  selectReusableCertificatePack,
} from "./seed-cloudflare-tunnel-pool.ts";

test("countMissingResources tops up to the requested pool size", () => {
  assert.equal(countMissingResources(0, 20), 20);
  assert.equal(countMissingResources(12, 20), 8);
  assert.equal(countMissingResources(20, 20), 0);
  assert.equal(countMissingResources(25, 20), 0);
});

test("buildIngressConfig creates a single-host tunnel config with a 404 fallback", () => {
  assert.deepEqual(
    buildIngressConfig({
      publicHostname: "funny-bot-cache.tunnel.iterate.com",
      service: "http://localhost:3000",
    }),
    {
      config: {
        ingress: [
          {
            hostname: "funny-bot-cache.tunnel.iterate.com",
            service: "http://localhost:3000",
          },
          {
            service: "http_status:404",
          },
        ],
        "warp-routing": {
          enabled: false,
        },
      },
    },
  );
});

test("buildDnsRecordBody targets the tunnel hostname", () => {
  assert.deepEqual(
    buildDnsRecordBody({
      publicHostname: "funny-bot-cache.tunnel.iterate.com",
      tunnelId: "1234-5678",
      comment: "managed",
    }),
    {
      type: "CNAME",
      name: "funny-bot-cache.tunnel.iterate.com",
      content: "1234-5678.cfargotunnel.com",
      proxied: true,
      ttl: 1,
      comment: "managed",
    },
  );
});

test("selectReusableCertificatePack prefers active or pending wildcard packs", () => {
  const match = selectReusableCertificatePack(
    [
      { id: "ignored", status: "deleted", hosts: ["*.tunnel.iterate.com"] },
      { id: "wanted", status: "active", hosts: ["tunnel.iterate.com", "*.tunnel.iterate.com"] },
    ],
    "*.tunnel.iterate.com",
  );

  assert.deepEqual(match, {
    id: "wanted",
    status: "active",
    hosts: ["tunnel.iterate.com", "*.tunnel.iterate.com"],
  });
});

test("pickUnusedSlug retries until it gets a new value", () => {
  const existingSlugs = new Set(["first-slug-here", "second-slug-here"]);
  const values = ["first-slug-here", "second-slug-here", "fresh-slug-here"];
  let index = 0;

  const slug = pickUnusedSlug(existingSlugs, () => values[index++]!);

  assert.equal(slug, "fresh-slug-here");
  assert.ok(existingSlugs.has("fresh-slug-here"));
});
