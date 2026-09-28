// src/project/dns-provider.test.ts — which provider a zone's nameservers name (a table of the
// customer-facing nameserver names), and the zone walk over DNS-over-HTTPS against a fake.
import { expect, test } from "vitest";
import { dnsProviderOf, dnsProviderOfNameservers } from "./dns-provider.ts";

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

test("the nearest zone above the hostname with nameservers names the provider", async () => {
  const asked: string[] = [];
  const provider = await dnsProviderOf("iterate.shop.example.com", (async (input: string) => {
    const name = new URL(input).searchParams.get("name")!;
    asked.push(name);
    return Response.json(
      name === "example.com"
        ? { Status: 0, Answer: [{ type: 2, data: "ns51.domaincontrol.com." }] }
        : { Status: 0, Answer: [{ type: 5, data: "cname.iterate.app." }] },
    );
  }) as unknown as typeof fetch);
  expect(provider).toBe("godaddy");
  expect(asked).toEqual(["shop.example.com", "example.com"]);
});

test("a DNS error throws (the caller logs it)", async () => {
  await expect(
    dnsProviderOf("iterate.example.com", (async () =>
      Response.json({ Status: 2 })) as unknown as typeof fetch),
  ).rejects.toThrow(/DNS status 2/);
});
