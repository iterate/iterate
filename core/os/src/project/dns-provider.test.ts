// src/project/dns-provider.test.ts — which provider a zone's nameservers name (a table of the
// customer-facing nameserver names), and the zone walk over DNS-over-HTTPS against a fake.
import { expect, test } from "vitest";
import {
  dnsProviderOfNameservers,
  dnsZoneOf,
  isCountryRegistry,
  txtRecordsOf,
} from "./dns-provider.ts";

test.for([
  { name: "Cloudflare", nameservers: ["giancarlo.ns.cloudflare.com."], provider: "cloudflare" },
  {
    name: "Namecheap BasicDNS",
    nameservers: ["dns1.registrar-servers.com"],
    provider: "namecheap",
  },
  { name: "GoDaddy", nameservers: ["ns51.domaincontrol.com."], provider: "godaddy" },
  {
    name: "Route 53",
    nameservers: ["ns-1447.awsdns-52.org.", "ns-12.awsdns-01.co.uk."],
    provider: "route53",
  },
  {
    name: "Google Cloud DNS",
    nameservers: ["ns-cloud-a1.googledomains.com."],
    provider: "google-cloud-dns",
  },
  { name: "Porkbun", nameservers: ["curitiba.ns.porkbun.com"], provider: "porkbun" },
  { name: "IONOS", nameservers: ["ns1040.ui-dns.com."], provider: "ionos" },
  { name: "NameSilo", nameservers: ["ns1.dnsowl.com"], provider: "namesilo" },
  { name: "Azure", nameservers: ["ns1-37.azure-dns.com."], provider: "azure" },
  { name: "deSEC", nameservers: ["ns1.desec.io.", "ns2.desec.org."], provider: "desec" },
  { name: "Spaceship", nameservers: ["launch1.spaceship.net"], provider: "spaceship" },
  { name: "unknown", nameservers: ["ns1.example-dns.test."], provider: null },
  {
    name: "a lookalike is not Cloudflare",
    nameservers: ["ns.cloudflare.com.evil.test"],
    provider: null,
  },
])("nameservers → provider: $name", ({ nameservers, provider }) => {
  expect(dnsProviderOfNameservers(nameservers)).toBe(provider);
});

test("the zone is the nearest name at or above the hostname with nameservers, and names the provider", async () => {
  const asked: string[] = [];
  const found = await dnsZoneOf("iterate.shop.example.com", (async (input: string) => {
    const name = new URL(input).searchParams.get("name")!;
    asked.push(name);
    return Response.json(
      name === "example.com"
        ? {
            Status: 0,
            Answer: [{ name: "example.com.", type: 2, data: "ns51.domaincontrol.com." }],
          }
        : // a CNAME the resolver followed into another zone's NS: not this zone's
          {
            Status: 0,
            Answer: [
              { name: name, type: 5, data: "cname.iterate.app." },
              { name: "iterate.app.", type: 2, data: "ns1.elsewhere.test." },
            ],
          },
    );
  }) as unknown as typeof fetch);
  expect(found).toEqual({ zone: "example.com", provider: "godaddy" });
  expect(asked).toEqual(["iterate.shop.example.com", "shop.example.com", "example.com"]);
});

test("a bare domain is its own zone", async () => {
  const found = await dnsZoneOf("effect.ninja", (async () =>
    Response.json({
      Status: 0,
      Answer: [{ name: "effect.ninja.", type: 2, data: "ingrid.ns.cloudflare.com." }],
    })) as unknown as typeof fetch);
  expect(found).toEqual({ zone: "effect.ninja", provider: "cloudflare" });
});

test("a DNS error throws (the caller logs it)", async () => {
  await expect(
    dnsZoneOf("iterate.example.com", (async () =>
      Response.json({ Status: 2 })) as unknown as typeof fetch),
  ).rejects.toThrow(/DNS status 2/);
});

test.for([
  { name: "co.uk", registry: true },
  { name: "com.au", registry: true },
  { name: "co.jp", registry: true },
  { name: "example.co.uk", registry: false },
  { name: "effect.ninja", registry: false },
  { name: "templestein.de", registry: false },
])("a country's registry is never a zone: $name", ({ name, registry }) => {
  expect(isCountryRegistry(name)).toBe(registry);
});

test("the walk stops before a country's registry: a zone that doesn't answer is no zone, never co.uk", async () => {
  const asked: string[] = [];
  const found = await dnsZoneOf("iterate.example.co.uk", (async (input: string) => {
    const name = new URL(input).searchParams.get("name")!;
    asked.push(name);
    return Response.json(
      name === "co.uk"
        ? { Status: 0, Answer: [{ name: "co.uk.", type: 2, data: "dns1.nic.uk." }] }
        : { Status: 3 },
    );
  }) as unknown as typeof fetch);
  expect(found).toBeNull();
  expect(asked).toEqual(["iterate.example.co.uk", "example.co.uk"]);
});

test("a name's TXT records are their texts, split strings joined; none when the name has none, nor the records of a CNAME's target", async () => {
  const answer = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;
  expect(
    await txtRecordsOf(
      "_iterate.effect.ninja",
      answer({
        Status: 0,
        Answer: [
          { name: "_iterate.effect.ninja.", type: 16, data: '"iterate-project=" "prj_1"' },
          { name: "_iterate.effect.ninja.", type: 16, data: '"v=other"' },
          // followed through a CNAME: another name's
          { name: "cname.iterate.app.", type: 16, data: '"iterate-project=prj_2"' },
        ],
      }),
    ),
  ).toEqual(["iterate-project=prj_1", "v=other"]);
  expect(await txtRecordsOf("_iterate.nothing.test", answer({ Status: 3 }))).toEqual([]);
  await expect(txtRecordsOf("_iterate.broken.test", answer({ Status: 2 }))).rejects.toThrow(
    /DNS status 2/,
  );
});
