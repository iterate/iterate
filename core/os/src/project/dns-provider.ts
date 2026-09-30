// src/project/dns-provider.ts — WHO HOSTS A HOSTNAME'S DNS, so the dash can say where and how to add
// its records when Domain Connect can't (domain-connect.ts): the zone the hostname lives in — the
// nearest name at or above it with nameservers (DNS-over-HTTPS NS lookups) — and its provider, by
// matching those nameservers against the providers below by their customer-facing names. The zone
// lets the dash show each record's name as the provider's form wants it (`iterate`, or `@` for the
// zone itself); the provider is an id the dash keys its instructions by (apps/dash
// `DNS_PROVIDER_GUIDES`), null for anything not listed.
// Best effort like Domain Connect: every request bounded, a failure throws for the caller to log.

import { z } from "zod";
import { domainConnectZonesOf, txtRecordText } from "./domain-connect.ts";

/** The providers we recognise, by the nameserver names they hand their customers. Order matters
 *  only where patterns could overlap (none do today). */
const PROVIDERS: { id: string; nameservers: RegExp }[] = [
  { id: "cloudflare", nameservers: /\.ns\.cloudflare\.com$/ },
  { id: "namecheap", nameservers: /\.registrar-servers\.com$/ },
  { id: "godaddy", nameservers: /\.domaincontrol\.com$/ },
  { id: "route53", nameservers: /\.awsdns-\d+\.(com|net|org|co\.uk)$/ },
  { id: "google-cloud-dns", nameservers: /^ns-cloud-[a-z]\d\.googledomains\.com$/ },
  { id: "porkbun", nameservers: /\.ns\.porkbun\.com$/ },
  { id: "gandi", nameservers: /\.gandi\.net$/ },
  { id: "ovh", nameservers: /\.ovh\.(net|ca)$/ },
  { id: "hover", nameservers: /\.hover\.com$/ },
  { id: "name-com", nameservers: /\.name\.com$/ },
  { id: "digitalocean", nameservers: /\.digitalocean\.com$/ },
  { id: "vercel", nameservers: /\.vercel-dns\.com$/ },
  { id: "dnsimple", nameservers: /\.dnsimple(-edge)?\.(com|net|org|info)$/ },
  { id: "hetzner", nameservers: /\.(ns\.hetzner\.(com|de)|second-ns\.(com|de))$/ },
  { id: "ionos", nameservers: /\.ui-dns\.(com|de|org|biz)$/ },
  { id: "dynadot", nameservers: /\.dyna-ns\.net$/ },
  { id: "namesilo", nameservers: /\.dnsowl\.com$/ },
  { id: "wix", nameservers: /\.wixdns\.net$/ },
  { id: "azure", nameservers: /\.azure-dns\.(com|net|org|info)$/ },
  { id: "linode", nameservers: /^ns\d\.linode\.com$/ },
  { id: "desec", nameservers: /\.desec\.(io|org)$/ },
  { id: "spaceship", nameservers: /^launch\d\.spaceship\.(net|com)$/ },
];

/** A DNS-over-HTTPS answer (RFC 8484's JSON form), as far as NS and TXT records go. */
const DohNsAnswer = z.object({
  Status: z.number(),
  Answer: z.array(z.object({ name: z.string(), type: z.number(), data: z.string() })).optional(),
});

/** A country's second-level registry, like `co.uk`, `com.au` or `co.jp`: a name with nameservers
 *  that is never a customer's zone. Two labels, a two-letter country code, and a common registry
 *  label — the multi-label public suffixes a customer domain sits under in practice (a full public
 *  suffix list would be exact, and heavy for this). Pure. */
export function isCountryRegistry(name: string): boolean {
  const labels = name.split(".");
  return (
    labels.length === 2 &&
    /^[a-z]{2}$/.test(labels[1]!) &&
    ["co", "com", "org", "net", "ac", "gov", "edu", "ne", "or", "ltd", "plc", "me", "gen"].includes(
      labels[0]!,
    )
  );
}

/** The provider a set of nameservers belongs to, or null. Pure. */
export function dnsProviderOfNameservers(nameservers: readonly string[]): string | null {
  const names = nameservers.map((name) => name.toLowerCase().replace(/\.$/, ""));
  return (
    PROVIDERS.find(({ nameservers: pattern }) => names.some((name) => pattern.test(name)))?.id ??
    null
  );
}

/** The zone `hostname` lives in — the nearest name at or above it with nameservers — and the
 *  provider those nameservers belong to; null when no zone answers. Throws on a DNS error or a
 *  timeout. `fetcher` reaches DNS-over-HTTPS (a test hands a fake). */
export async function dnsZoneOf(
  hostname: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<{ zone: string; provider: string | null } | null> {
  const zones = [hostname, ...domainConnectZonesOf(hostname).map(({ domain }) => domain)];
  // never above a country's registry: past the customer's own zone (a typo, a delegation not yet
  // seen), `co.uk` would answer, and every record's name would come out wrong
  for (const domain of zones) {
    if (isCountryRegistry(domain)) return null;
    const response = await fetcher(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=NS`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5_000) },
    );
    const dns = DohNsAnswer.parse(await response.json());
    if (dns.Status !== 0 && dns.Status !== 3)
      throw new Error(`DNS status ${dns.Status} for ${domain} NS`);
    // the zone's own NS records only: a resolver follows a CNAME, and the target's zone is not ours
    const nameservers = (dns.Answer || []).filter(
      (record) => record.type === 2 && record.name.replace(/\.$/, "").toLowerCase() === domain,
    );
    if (nameservers.length)
      return {
        zone: domain,
        provider: dnsProviderOfNameservers(nameservers.map((ns) => ns.data)),
      };
  }
  return null;
}

/** The texts of `name`'s own TXT records over DNS-over-HTTPS, none when it has none. Only records
 *  AT `name`: a resolver follows a CNAME — the wildcard `*.<hostname>` answers `_iterate.<hostname>`
 *  too — and the target's records are not the name's. Throws on a DNS error or a timeout.
 *  `fetcher` reaches DNS-over-HTTPS (a test hands a fake). */
export async function txtRecordsOf(
  name: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<string[]> {
  const response = await fetcher(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
    { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5_000) },
  );
  const dns = DohNsAnswer.parse(await response.json());
  if (dns.Status !== 0 && dns.Status !== 3)
    throw new Error(`DNS status ${dns.Status} for ${name} TXT`);
  return (dns.Answer || [])
    .filter((record) => record.type === 16 && record.name.replace(/\.$/, "").toLowerCase() === name)
    .map((record) => txtRecordText(record.data));
}
