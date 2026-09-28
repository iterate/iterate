// src/project/domain-connect.ts — ONE-CLICK DNS for a project's own hostname, over Domain Connect's
// synchronous flow (https://www.domainconnect.org). Our template, `iterate.com/custom-hostname`
// (github.com/Domain-Connect/Templates `iterate.com.custom-hostname.json`), writes the three CNAMEs
// custom-hostnames.ts `customHostnameRecords` names under a host the owner picked. A DNS provider
// that has onboarded it shows the owner those records and writes them on one click, then sends the
// browser back. Four steps, each its own function:
//   discovery    `_domainconnect.<zone>` TXT names the provider's API host (over DNS-over-HTTPS),
//                trying the zones above the hostname, most specific first
//   settings     `https://<that>/v2/<zone>/settings`: the provider's name and its apply UX
//   template     `<urlAPI>/v2/domainTemplates/providers/iterate.com/services/custom-hostname`
//                answers 200 once the provider has onboarded our template
//   the link     the apply URL, SIGNED: RS256 over its query string, which the provider verifies
//                against the public key published at `_dck1.iterate.com` (the private key is
//                APP_CONFIG `domainConnect.privateKey`)
// A provider without Domain Connect, or without our template, answers no link: the owner adds the
// records by hand.

/** Our template and the TXT record holding its signing key, as published. */
const TEMPLATE = { providerId: "iterate.com", serviceId: "custom-hostname", key: "_dck1" };

/** What the dash offers: the provider's name and the signed link that applies the records there. */
export type DomainConnectLink = { provider: string; url: string };

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

/** The apply URL for our template on `domain` under `host`, returning the browser to
 *  `redirectUri`, signed with `privateKey` (PKCS#8, base64 DER): the signature covers the query
 *  string exactly as sent, before `sig` and `key` are appended. */
export async function signedApplyUrl(input: {
  urlSyncUX: string;
  domain: string;
  host: string;
  redirectUri: string;
  privateKey: string;
}): Promise<string> {
  const query = new URLSearchParams({
    domain: input.domain,
    host: input.host,
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
  return `${base}/v2/domainTemplates/providers/${TEMPLATE.providerId}/services/${TEMPLATE.serviceId}/apply?${query}&${new URLSearchParams({ sig, key: TEMPLATE.key })}`;
}

/** The link that applies our template for `hostname`, or null when its DNS provider has no
 *  Domain Connect or has not onboarded our template. `fetcher` reaches DNS-over-HTTPS and the
 *  provider (a test hands a fake). */
export async function domainConnectLinkOf(
  hostname: string,
  options: { redirectUri: string; privateKey: string; fetcher?: typeof fetch },
): Promise<DomainConnectLink | null> {
  const fetcher = options.fetcher || ((input, init) => fetch(input, init));
  for (const { domain, host } of domainConnectZonesOf(hostname)) {
    const dns = await fetcher(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(`_domainconnect.${domain}`)}&type=TXT`,
      { headers: { accept: "application/dns-json" } },
    );
    const answer = ((await dns.json()) as { Answer?: { type: number; data: string }[] }).Answer;
    const apiHost = answer?.find((record) => record.type === 16)?.data.replaceAll('"', "");
    if (!apiHost) continue;
    const settings = await fetcher(`https://${apiHost}/v2/${domain}/settings`);
    if (!settings.ok) return null;
    const { providerName, providerDisplayName, urlSyncUX, urlAPI } = (await settings.json()) as {
      providerName?: string;
      providerDisplayName?: string;
      urlSyncUX?: string;
      urlAPI?: string;
    };
    if (!urlSyncUX || !urlAPI) return null;
    const template = await fetcher(
      `${urlAPI.replace(/\/$/, "")}/v2/domainTemplates/providers/${TEMPLATE.providerId}/services/${TEMPLATE.serviceId}`,
    );
    if (!template.ok) return null;
    return {
      provider: providerDisplayName || providerName || apiHost,
      url: await signedApplyUrl({
        urlSyncUX,
        domain,
        host,
        redirectUri: options.redirectUri,
        privateKey: options.privateKey,
      }),
    };
  }
  return null;
}
