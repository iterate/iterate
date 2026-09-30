// src/lib/dns-provider-guides.ts — WHERE AND HOW to add a hostname's records by hand (three CNAMEs and
// the TXT record that proves it is the owner's), for the DNS
// providers core/os recognises by their nameservers (core/os src/project/dns-provider.ts, whose ids
// key this table). The Domains page shows the guide for the provider a hostname's DNS is on, under
// the Connect button when there is one. Every name field wants the part before the customer's domain
// (`iterate`, `*.iterate`, `_acme-challenge.iterate` for `iterate.example.com`); `trailingDot` marks
// the providers whose target field wants the final dot. Paths follow each provider's own docs as of
// 2026-09; a provider not listed gets the generic table.

export type DnsProviderGuide = {
  name: string;
  /** Where the provider's DNS settings are. */
  url: string;
  /** The clicks there, one line each. */
  steps: string[];
  /** The target field wants `cname.iterate.app.` with its final dot. */
  trailingDot?: boolean;
  /** What trips people up there. */
  notes?: string[];
  /** false: its DNS can't point a bare domain at another name (no CNAME flattening or ALIAS). */
  apex?: false;
};

const NAME = "the part of each name before your domain (like `iterate`)";

export const DNS_PROVIDER_GUIDES: Record<string, DnsProviderGuide> = {
  cloudflare: {
    name: "Cloudflare",
    url: "https://dash.cloudflare.com/",
    steps: [
      "Open your domain, then DNS → Records → Add record.",
      `Type CNAME, Name: ${NAME}, Target as shown.`,
      "Set Proxy status to DNS only (grey cloud) on all three records.",
    ],
    notes: [
      "Delete any `_acme-challenge` TXT records for this name first: they block the certificate.",
    ],
  },
  namecheap: {
    name: "Namecheap",
    url: "https://ap.www.namecheap.com/domains/list/",
    steps: [
      "Domain List → Manage next to your domain → Advanced DNS.",
      `Add New Record → CNAME Record. Host: ${NAME}, Value as shown.`,
    ],
    notes: ["This works while the domain uses Namecheap BasicDNS or PremiumDNS."],
  },
  godaddy: {
    apex: false,
    name: "GoDaddy",
    url: "https://dcc.godaddy.com/control/portfolio",
    steps: [
      "My Products → your domain → DNS → Add New Record.",
      `Type CNAME, Name: ${NAME}, Value as shown.`,
    ],
  },
  route53: {
    apex: false,
    name: "Amazon Route 53",
    url: "https://console.aws.amazon.com/route53/v2/hostedzones",
    steps: [
      "Hosted zones → your domain → Create record.",
      `Record name: ${NAME}, Record type CNAME, Value as shown, Routing policy Simple.`,
    ],
  },
  "google-cloud-dns": {
    apex: false,
    name: "Google Cloud DNS",
    url: "https://console.cloud.google.com/net-services/dns/zones",
    steps: [
      "Cloud DNS → your zone → Add standard.",
      `DNS name: ${NAME}, Resource record type CNAME, Canonical name as shown.`,
    ],
    trailingDot: true,
    notes: [
      "Domains moved from Google Domains to Squarespace use these nameservers too: if that's yours, add the records under Squarespace → Domains → DNS.",
    ],
  },
  porkbun: {
    name: "Porkbun",
    url: "https://porkbun.com/account/domainsSpeedy",
    steps: [
      "Domain Management → DNS next to your domain.",
      `Type CNAME, Host: ${NAME}, Answer as shown.`,
    ],
  },
  gandi: {
    name: "Gandi",
    url: "https://admin.gandi.net/domain/",
    steps: [
      "Domain → your domain → DNS Records → Add record.",
      `Type CNAME, Name: ${NAME}, Hostname as shown.`,
    ],
    trailingDot: true,
  },
  ovh: {
    name: "OVHcloud",
    url: "https://www.ovh.com/manager/#/web/domain",
    steps: [
      "Web Cloud → Domain names → your domain → DNS zone → Add an entry → CNAME.",
      `Subdomain: ${NAME}, Target as shown.`,
    ],
    trailingDot: true,
  },
  hover: {
    name: "Hover",
    url: "https://www.hover.com/control_panel/domains",
    steps: ["Your domain → DNS → Add a record.", `Type CNAME, Hostname: ${NAME}, Target as shown.`],
  },
  "name-com": {
    name: "Name.com",
    url: "https://www.name.com/account/domain",
    steps: [
      "My Domains → your domain → Manage DNS Records.",
      `Type CNAME, Host: ${NAME}, Answer as shown.`,
    ],
  },
  digitalocean: {
    apex: false,
    name: "DigitalOcean",
    url: "https://cloud.digitalocean.com/networking/domains",
    steps: [
      "Networking → Domains → your domain → CNAME.",
      `Hostname: ${NAME}, Is an alias of: as shown.`,
    ],
  },
  vercel: {
    name: "Vercel",
    url: "https://vercel.com/dashboard/domains",
    steps: [
      "Domains → your domain → DNS Records → Add.",
      `Name: ${NAME}, Type CNAME, Value as shown.`,
    ],
  },
  dnsimple: {
    name: "DNSimple",
    url: "https://dnsimple.com/dashboard",
    steps: [
      "Your domain → DNS → Manage records → Add record → CNAME.",
      `Name: ${NAME}, Alias for: as shown.`,
    ],
  },
  hetzner: {
    apex: false,
    name: "Hetzner DNS",
    url: "https://dns.hetzner.com/",
    steps: ["Your zone → Add record.", `Type CNAME, Name: ${NAME}, Value as shown.`],
    trailingDot: true,
  },
  ionos: {
    apex: false,
    name: "IONOS",
    url: "https://my.ionos.com/domains",
    steps: [
      "Domains & SSL → your domain → DNS → Add record → CNAME.",
      `Host name: ${NAME}, Points to: as shown.`,
    ],
  },
  dynadot: {
    name: "Dynadot",
    url: "https://www.dynadot.com/account/domain/name/list.html",
    steps: [
      "My Domains → Manage Domains → your domain → DNS Settings.",
      `Under Subdomain Records: Subdomain: ${NAME}, Record Type CNAME, value as shown.`,
    ],
  },
  namesilo: {
    name: "NameSilo",
    url: "https://www.namesilo.com/account_domains.php",
    steps: [
      "Domain Manager → Manage DNS next to your domain.",
      `CNAME: Hostname: ${NAME}, Target as shown.`,
    ],
  },
  wix: {
    name: "Wix",
    url: "https://manage.wix.com/account/domains",
    steps: [
      "Domains → ⋯ next to your domain → Manage DNS Records.",
      `CNAME → Add Record. Host name: ${NAME}, Value as shown.`,
    ],
    notes: ["If Wix refuses the `*.` record, your site works but its apps get no addresses."],
  },
  azure: {
    apex: false,
    name: "Azure DNS",
    url: "https://portal.azure.com/#browse/Microsoft.Network%2FdnsZones",
    steps: ["Your DNS zone → Record sets → + Add.", `Name: ${NAME}, Type CNAME, Alias as shown.`],
  },
  linode: {
    apex: false,
    name: "Linode (Akamai)",
    url: "https://cloud.linode.com/domains",
    steps: [
      "Domains → your domain → CNAME Records → Add a CNAME Record.",
      `Hostname: ${NAME}, Alias to: as shown.`,
    ],
    notes: [
      "Linode's DNS Manager may refuse the two-level names (`*.iterate`, `_acme-challenge.iterate`): then add your hostname as a domain of its own in Linode and delegate it there.",
    ],
  },
  desec: {
    name: "deSEC",
    url: "https://desec.io/domains",
    steps: ["Your domain → + → Record Set Type CNAME.", `Subname: ${NAME}, Target as shown.`],
    trailingDot: true,
    notes: ["deSEC's minimum TTL is an hour, so the first check can take that long."],
  },
  spaceship: {
    name: "Spaceship",
    url: "https://www.spaceship.com/application/advanced-dns-application/",
    steps: [
      "Launchpad → Advanced DNS → your domain → Custom records → Add record → CNAME.",
      `Host: ${NAME}, Value as shown.`,
    ],
  },
};
