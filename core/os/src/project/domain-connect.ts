// src/project/domain-connect.ts — ONE-CLICK DNS for a project's own hostname, over Domain Connect's
// synchronous flow (https://www.domainconnect.org). Our template, `iterate.com/custom-hostname`
// (github.com/Domain-Connect/Templates `iterate.com.custom-hostname.json`), writes the three CNAMEs
// custom-hostnames.ts `customHostnameRecords` names under a host the owner picked. A DNS provider
// that has onboarded it shows the owner those records and writes them on one click, then sends the
// browser back. Four steps:
//   discovery    `_domainconnect.<zone>` TXT names the provider's API host (over DNS-over-HTTPS),
//                trying the zones above the hostname, most specific first
//   settings     `https://<that>/v2/<zone>/settings`: the provider's name and its apply UX
//   template     `<urlAPI>/v2/domainTemplates/providers/iterate.com/services/custom-hostname`
//                answers 200 once the provider has onboarded our template
//   the link     the apply URL, SIGNED: RS256 over its query string, which the provider verifies
//                against the public key published at `_dck1.iterate.com` (the private key is
//                APP_CONFIG `domainConnect.privateKey`)
// A zone whose provider does not answer for it, or has not onboarded our template, answers no link
// and the next zone up is tried; with none, the owner adds the records by hand. Every request is
// bounded (REQUEST_TIMEOUT_MS) and follows no redirect (a 3xx answers nothing), every answer is parsed, and every URL a DNS
// record or a provider hands us must be https: what DNS says is data, never trusted as a target.
// A failure (a DNS error, a provider's 5xx, a timeout) throws — the caller logs it and settles
// without a link.

import { z } from "zod";

/** Our templates and the TXT record holding their signing key, as published: `custom-hostname`
 *  for a name under the zone (hostRequired: the host is the name's labels under it), and
 *  `custom-hostname-apex` for the zone itself (an APEXCNAME at `@`, for providers with ALIAS or
 *  flattening). Cloudflare ignores hostRequired and flattens a CNAME at the apex, so there the zone
 *  itself takes `custom-hostname` without a host. */
const TEMPLATE = {
  providerId: "iterate.com",
  subdomain: "custom-hostname",
  apex: "custom-hostname-apex",
  key: "_dck1",
};

/** One provider request's budget: discovery runs inside a hostname's add, which it must never hold. */
const REQUEST_TIMEOUT_MS = 5_000;

/** What the dash offers: the provider's name and the signed link that applies the records there. */
export type DomainConnectLink = { provider: string; url: string };

/** An https URL, nothing else: a scheme a DNS record picked is never fetched or linked. */
const HttpsUrl = z.url({ protocol: /^https$/ });

/** A DNS-over-HTTPS answer (RFC 8484's JSON form): the status, and TXT records as presentation
 *  strings. */
const DohTxtAnswer = z.object({
  Status: z.number(),
  Answer: z.array(z.object({ type: z.number(), data: z.string() })).optional(),
});

/** A provider's settings for a zone (Domain Connect spec, "Discover Domain Connect"). */
const ProviderSettings = z.object({
  providerName: z.string().min(1),
  providerDisplayName: z.string().min(1).optional(),
  urlSyncUX: HttpsUrl,
  urlAPI: HttpsUrl,
});

/** The zones `hostname` may live in and the host under each, most specific first:
 *  `iterate.shop.example.com` ⇒ `shop.example.com` host `iterate`, then `example.com` host
 *  `iterate.shop`. Never the hostname itself (the template requires a host) nor a single label.
 *  Pure. */
export function domainConnectZonesOf(hostname: string): { domain: string; host: string }[] {
  const labels = hostname.split(".");
  return labels.slice(1, -1).map((_, index) => ({
    domain: labels.slice(index + 1).join("."),
    host: labels.slice(0, index + 1).join("."),
  }));
}

/** A TXT record's text from its presentation form — one or more quoted strings, concatenated
 *  without the whitespace between them, backslash escapes undone. Pure. */
export function txtRecordText(data: string): string {
  const strings = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]!);
  return (strings.length ? strings.join("") : data).replace(/\\(\d{3}|.)/g, (_, escaped: string) =>
    escaped.length === 3 ? String.fromCharCode(Number(escaped)) : escaped,
  );
}

/** The apply URL for our template `serviceId` on `domain` under `host` (empty: the zone itself),
 *  for `project` (the template's `%project%`, which its ownership TXT names), returning the browser
 *  to `redirectUri`, signed with `privateKey` (PKCS#8, base64 DER). The signature covers the query
 *  string exactly as sent, without `key` and `sig`; `sig` comes LAST (Cloudflare requires it). */
export async function signedApplyUrl(input: {
  urlSyncUX: string;
  serviceId: string;
  domain: string;
  host: string;
  project: string;
  redirectUri: string;
  privateKey: string;
}): Promise<string> {
  const query = new URLSearchParams({
    domain: input.domain,
    // oxlint-disable-next-line iterate/simple-truthiness-check -- the protocol: no host parameter at all means the zone itself; an empty `host=` is not the same request
    ...(input.host && { host: input.host }),
    project: input.project,
    redirect_uri: input.redirectUri,
  }).toString();
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(input.privateKey), (char) => char.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(query)),
  );
  const sig = btoa(String.fromCharCode(...signature));
  const base = input.urlSyncUX.replace(/\/$/, "");
  return `${base}/v2/domainTemplates/providers/${TEMPLATE.providerId}/services/${input.serviceId}/apply?${query}&${new URLSearchParams({ key: TEMPLATE.key, sig })}`;
}

/** The link that applies our template for `hostname` in `project`, or null when no zone at or
 *  above it has a DNS provider that answers for it with the template it needs onboarded. Throws on a
 *  DNS error, a provider's 5xx or a timeout. `fetcher` reaches DNS-over-HTTPS and the provider (a
 *  test hands a fake). */
export async function domainConnectLinkOf(
  hostname: string,
  options: {
    project: string;
    redirectUri: string;
    privateKey: string;
    fetcher?: typeof fetch;
  },
): Promise<DomainConnectLink | null> {
  const fetcher = options.fetcher || ((input, init) => fetch(input, init));
  const request = async (url: string, headers?: Record<string, string>) => {
    const response = await fetcher(url, {
      headers,
      // never followed: a redirect is not `ok`, so it answers nothing (Workers has no "error")
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status >= 500) throw new Error(`${new URL(url).host} answered ${response.status}`);
    return response;
  };
  // the hostname itself first: it may be a zone of its own (a bare domain, a delegated subdomain)
  for (const { domain, host } of [
    { domain: hostname, host: "" },
    ...domainConnectZonesOf(hostname),
  ]) {
    const dns = DohTxtAnswer.parse(
      await (
        await request(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(`_domainconnect.${domain}`)}&type=TXT`,
          { accept: "application/dns-json" },
        )
      ).json(),
    );
    // NOERROR or NXDOMAIN answer the question; anything else (SERVFAIL, REFUSED) is a failure
    if (dns.Status !== 0 && dns.Status !== 3)
      throw new Error(`DNS status ${dns.Status} for _domainconnect.${domain}`);
    const txt = dns.Answer?.find((record) => record.type === 16);
    if (!txt) continue;
    const settingsUrl = HttpsUrl.safeParse(
      `https://${txtRecordText(txt.data).trim()}/v2/${domain}/settings`,
    );
    if (!settingsUrl.success) continue;
    // a provider that does not answer for this zone (a wildcard's TXT, a stale record): try the next
    const settings = await request(settingsUrl.data);
    if (!settings.ok) continue;
    const parsed = ProviderSettings.safeParse(await settings.json());
    if (!parsed.success) continue;
    const { providerName, providerDisplayName, urlSyncUX, urlAPI } = parsed.data;
    const serviceId =
      host || providerName.toLowerCase() === "cloudflare" ? TEMPLATE.subdomain : TEMPLATE.apex;
    const template = await request(
      `${urlAPI.replace(/\/$/, "")}/v2/domainTemplates/providers/${TEMPLATE.providerId}/services/${serviceId}`,
    );
    if (!template.ok) continue;
    return {
      provider: providerDisplayName || providerName,
      url: await signedApplyUrl({
        urlSyncUX,
        serviceId,
        domain,
        host,
        project: options.project,
        redirectUri: options.redirectUri,
        privateKey: options.privateKey,
      }),
    };
  }
  return null;
}
