// src/project/domain-connect.test.ts — Domain Connect's four steps against fakes: the zones a
// hostname may live in (a table), the apply link signed so a provider verifying it against our
// public key accepts it, and discovery → settings → template → link, with each way to answer none.
import { expect, test } from "vitest";
import { domainConnectLinkOf, domainConnectZonesOf, signedApplyUrl } from "./domain-connect.ts";

test.for([
  {
    name: "a subdomain of a registrable domain",
    hostname: "iterate.templestein.com",
    zones: [{ domain: "templestein.com", host: "iterate" }],
  },
  {
    name: "deeper: every zone above it, most specific first",
    hostname: "iterate.shop.example.co.uk",
    zones: [
      { domain: "shop.example.co.uk", host: "iterate" },
      { domain: "example.co.uk", host: "iterate.shop" },
      { domain: "co.uk", host: "iterate.shop.example" },
    ],
  },
  {
    name: "a bare domain has no host to put the records under: the template requires one",
    hostname: "templestein.com",
    zones: [],
  },
])("the zones a hostname may live in: $name", ({ hostname, zones }) => {
  expect(domainConnectZonesOf(hostname)).toEqual(zones);
});

test("the apply link names our template, carries domain, host and redirect_uri, and is signed over its query string before sig and key", async () => {
  const { privateKey, publicKey } = await keyPair();
  const url = new URL(
    await signedApplyUrl({
      urlSyncUX: "https://dash.cloudflare.com/domainconnect/",
      domain: "templestein.com",
      host: "iterate",
      redirectUri:
        "https://dash.iterate.com/projects/prj_1/hostnames?connected=iterate.templestein.com",
      privateKey,
    }),
  );
  expect(url.origin + url.pathname).toBe(
    "https://dash.cloudflare.com/domainconnect/v2/domainTemplates/providers/iterate.com/services/custom-hostname/apply",
  );
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    domain: "templestein.com",
    host: "iterate",
    redirect_uri:
      "https://dash.iterate.com/projects/prj_1/hostnames?connected=iterate.templestein.com",
    key: "_dck1",
  });
  // what the provider does: the query string up to `&sig=`, verified against the public key
  const signed = url.search.slice(1, url.search.indexOf("&sig="));
  const signature = Uint8Array.from(atob(url.searchParams.get("sig")!), (c) => c.charCodeAt(0));
  expect(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      signature,
      new TextEncoder().encode(signed),
    ),
  ).toBe(true);
});

test("discovery walks up to the zone that publishes _domainconnect, reads its settings, checks our template, and signs the link", async () => {
  const { privateKey } = await keyPair();
  const asked: string[] = [];
  const link = await domainConnectLinkOf("iterate.shop.example.com", {
    redirectUri: "https://dash.iterate.com/back",
    privateKey,
    fetcher: provider(asked, { zone: "example.com", template: 200 }),
  });
  expect(link).toMatchObject({ provider: "Cloudflare" });
  expect(new URL(link!.url).searchParams.get("host")).toBe("iterate.shop");
  expect(asked).toEqual([
    "dns _domainconnect.shop.example.com",
    "dns _domainconnect.example.com",
    "https://api.dc.test/v2/example.com/settings",
    "https://api.dc.test/v2/domainTemplates/providers/iterate.com/services/custom-hostname",
  ]);
});

test("no link when no zone above the hostname speaks Domain Connect, or its provider has not onboarded our template", async () => {
  const { privateKey } = await keyPair();
  const options = { redirectUri: "https://dash.iterate.com/back", privateKey };
  expect(
    await domainConnectLinkOf("iterate.example.com", {
      ...options,
      fetcher: provider([], { zone: null, template: 200 }),
    }),
  ).toBeNull();
  expect(
    await domainConnectLinkOf("iterate.example.com", {
      ...options,
      fetcher: provider([], { zone: "example.com", template: 404 }),
    }),
  ).toBeNull();
});

/** A DNS-over-HTTPS resolver and a Domain Connect provider, faked: `zone` publishes
 *  `_domainconnect` (null: none does), and the template check answers `template`. */
function provider(asked: string[], { zone, template }: { zone: string | null; template: number }) {
  return (async (input: string) => {
    const url = new URL(input);
    if (url.hostname === "cloudflare-dns.com") {
      const name = url.searchParams.get("name")!;
      asked.push(`dns ${name}`);
      return Response.json(
        name === `_domainconnect.${zone}` ? { Answer: [{ type: 16, data: '"api.dc.test"' }] } : {},
      );
    }
    asked.push(input);
    if (url.pathname.endsWith("/settings"))
      return Response.json({
        providerName: "cloudflare",
        providerDisplayName: "Cloudflare",
        urlSyncUX: "https://ux.dc.test",
        urlAPI: "https://api.dc.test",
      });
    return new Response(null, { status: template });
  }) as typeof fetch;
}

/** A fresh RS256 key pair, the private half as the config holds it: PKCS#8, base64 DER. */
async function keyPair() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  return { privateKey: btoa(String.fromCharCode(...pkcs8)), publicKey: pair.publicKey };
}
