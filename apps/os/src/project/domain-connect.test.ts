// src/project/domain-connect.test.ts — Domain Connect's four steps against fakes: the zones a
// hostname may live in (a table), the apply link signed so a provider verifying it against our
// public key accepts it, and discovery → settings → template → link, with each way to answer none.
import { expect, test } from "vitest";
import {
  domainConnectLinkOf,
  domainConnectZonesOf,
  signedApplyUrl,
  txtRecordText,
} from "./domain-connect.ts";

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
      serviceId: "custom-hostname",
      domain: "templestein.com",
      host: "iterate",
      project: "prj_1",
      redirectUri:
        "https://dash.iterate.com/projects/prj_1/domains?connected=iterate.templestein.com",
      privateKey,
    }),
  );
  expect(url.origin + url.pathname).toBe(
    "https://dash.cloudflare.com/domainconnect/v2/domainTemplates/providers/iterate.com/services/custom-hostname/apply",
  );
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    domain: "templestein.com",
    host: "iterate",
    project: "prj_1",
    redirect_uri:
      "https://dash.iterate.com/projects/prj_1/domains?connected=iterate.templestein.com",
    key: "_dck1",
  });
  // Cloudflare requires `sig` last
  expect([...url.searchParams.keys()].at(-1)).toBe("sig");
  // what the provider does: the query string without `key` and `sig`, verified against the public key
  const signed = url.search
    .slice(1)
    .split("&")
    .filter((pair) => !pair.startsWith("key=") && !pair.startsWith("sig="))
    .join("&");
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
    project: "prj_1",
    privateKey,
    fetcher: provider(asked, { zone: "example.com", template: 200 }),
  });
  expect(link).toMatchObject({ provider: "Cloudflare" });
  expect(new URL(link!.url).searchParams.get("host")).toBe("iterate.shop");
  expect(asked).toEqual([
    "dns _domainconnect.iterate.shop.example.com",
    "dns _domainconnect.shop.example.com",
    "dns _domainconnect.example.com",
    "https://api.dc.test/v2/example.com/settings",
    "https://api.dc.test/v2/domainTemplates/providers/iterate.com/services/custom-hostname",
  ]);
});

test("a bare domain on Cloudflare takes our subdomain template without a host (Cloudflare ignores hostRequired and flattens the apex CNAME); elsewhere it takes the apex template", async () => {
  const { privateKey } = await keyPair();
  const asked: string[] = [];
  for (const [providerName, service] of [
    ["cloudflare", "custom-hostname"],
    ["godaddy", "custom-hostname-apex"],
  ]) {
    const fake = provider(asked, { zone: "effect.ninja", template: 200 });
    const link = await domainConnectLinkOf("effect.ninja", {
      redirectUri: "https://dash.iterate.com/back",
      project: "prj_1",
      privateKey,
      fetcher: (async (input: string, init?: RequestInit) => {
        const answer = await fake(input, init);
        if (!input.endsWith("/settings")) return answer;
        return Response.json({ ...((await answer.json()) as object), providerName });
      }) as typeof fetch,
    });
    const url = new URL(link!.url);
    expect(url).toMatchObject({
      pathname: `/v2/domainTemplates/providers/iterate.com/services/${service}/apply`,
    });
    expect(url.searchParams.has("host")).toBe(false);
    expect(url.searchParams.get("domain")).toBe("effect.ninja");
  }
  expect(asked.filter((line) => line.includes("/domainTemplates/"))).toEqual([
    "https://api.dc.test/v2/domainTemplates/providers/iterate.com/services/custom-hostname",
    "https://api.dc.test/v2/domainTemplates/providers/iterate.com/services/custom-hostname-apex",
  ]);
});

test.for([
  { name: "one string", data: '"api.cloudflare.com/client/v4/dns/domainconnect"' },
  { name: "split strings", data: '"api.cloudflare.com/client" "/v4/dns/domainconnect"' },
  { name: "unquoted", data: "api.cloudflare.com/client/v4/dns/domainconnect" },
])("a TXT record's text: $name", ({ data }) => {
  expect(txtRecordText(data)).toBe("api.cloudflare.com/client/v4/dns/domainconnect");
});

test("a zone whose provider does not answer for it is passed over for the next one up", async () => {
  const { privateKey } = await keyPair();
  const link = await domainConnectLinkOf("iterate.shop.example.com", {
    redirectUri: "https://dash.iterate.com/back",
    project: "prj_1",
    privateKey,
    fetcher: provider([], { zone: "example.com", template: 200, decoy: "shop.example.com" }),
  });
  expect(new URL(link!.url).searchParams.get("domain")).toBe("example.com");
});

test("a DNS error or a provider's 5xx throws (the caller logs it); an http URL from a provider is never followed", async () => {
  const { privateKey } = await keyPair();
  const options = { redirectUri: "https://dash.iterate.com/back", project: "prj_1", privateKey };
  await expect(
    domainConnectLinkOf("iterate.example.com", {
      ...options,
      fetcher: (async () => Response.json({ Status: 2 })) as unknown as typeof fetch,
    }),
  ).rejects.toThrow(/DNS status 2/);
  await expect(
    domainConnectLinkOf("iterate.example.com", {
      ...options,
      fetcher: provider([], { zone: "example.com", template: 503 }),
    }),
  ).rejects.toThrow(/answered 503/);
  expect(
    await domainConnectLinkOf("iterate.example.com", {
      ...options,
      fetcher: provider([], { zone: "example.com", template: 200, syncUX: "http://ux.dc.test" }),
    }),
  ).toBeNull();
});

test("every provider request follows no redirect the Workers way (`manual`; the runtime refuses `error`), and a redirect answers nothing", async () => {
  const { privateKey } = await keyPair();
  const redirects: RequestInit["redirect"][] = [];
  const fake = provider([], { zone: "example.com", template: 200 });
  const link = await domainConnectLinkOf("iterate.example.com", {
    redirectUri: "https://dash.iterate.com/back",
    project: "prj_1",
    privateKey,
    fetcher: (async (input: string, init?: RequestInit) => {
      redirects.push(init?.redirect);
      // the settings answer a redirect: never followed, so no link
      if (input.endsWith("/settings")) return new Response(null, { status: 301 });
      return fake(input, init);
    }) as typeof fetch,
  });
  expect(link).toBeNull();
  expect(new Set(redirects)).toEqual(new Set(["manual"]));
});

test("no link when no zone above the hostname speaks Domain Connect, or its provider has not onboarded our template", async () => {
  const { privateKey } = await keyPair();
  const options = { redirectUri: "https://dash.iterate.com/back", project: "prj_1", privateKey };
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
 *  `_domainconnect` (null: none does), and so does `decoy`, whose provider answers 404 for it; the
 *  template check answers `template`; the settings name `syncUX` as the apply UX. */
function provider(
  asked: string[],
  options: { zone: string | null; template: number; decoy?: string; syncUX?: string },
) {
  return (async (input: string) => {
    const url = new URL(input);
    if (url.hostname === "cloudflare-dns.com") {
      const name = url.searchParams.get("name")!;
      asked.push(`dns ${name}`);
      const published = [options.zone, options.decoy].some(
        (zone) => name === `_domainconnect.${zone}`,
      );
      return Response.json({
        Status: published ? 0 : 3,
        ...(published && { Answer: [{ type: 16, data: '"api.dc." "test"' }] }),
      });
    }
    asked.push(input);
    if (url.pathname.endsWith("/settings"))
      return url.pathname === `/v2/${options.decoy}/settings`
        ? new Response(null, { status: 404 })
        : Response.json({
            providerName: "cloudflare",
            providerDisplayName: "Cloudflare",
            urlSyncUX: options.syncUX || "https://ux.dc.test",
            urlAPI: "https://api.dc.test",
          });
    return new Response(null, { status: options.template });
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
