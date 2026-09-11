# Project and custom hostname ingress — 5 September 2026

The host adapter resolves deployment-owned names to `projectId + /`. It does
not load a directory, create contexts for app labels, or add another HTTP
policy. Both project hostnames and custom hostnames call the existing
`routeFetch()` with the original request URL.

```ts
const names = {
  PROJECTS: { acme: "project-acme" },
  CUSTOM_HOSTNAMES: { "customerdomain.com": "project-acme" },
};
// acme.localhost:8799          -> project-acme /, app null
// docs--acme.localhost:8799    -> project-acme /, app "docs"
// docs.customerdomain.com     -> project-acme /, app "docs"
// anything.customerdomain.com -> project-acme /, app "anything"
```

An exact registered hostname takes precedence over the one-label custom
fallback. Likewise a complete project slug wins before interpreting `--` as
an app separator. App labels need no registration. Unknown project hostnames
do not fall through to a default project. Nested names such as
`a.b.customerdomain.com` are not implied by this one-label rule or its TLS
certificate requirements.

The project policy sees the original URL and a freshly derived
`x-iterate-app` hint. Caller-provided `x-core-*`, `x-itx-*` and `x-iterate-*`
headers are stripped first. This is routing, not authentication: a host-routed
request reaches the project's policy without the dashboard demo login. The
map establishes neither DNS ownership nor project membership.

## Public HTTP proof

Before the host adapter, the first request to
`http://demo.localhost:8799/notes?q=1` returned **421 Wrong origin**, failing
the expected 200 assertion (21.5445 ms). With the adapter, the test passed.

The retained `e2e/hostnames.test.ts` installs a policy through `/api` and makes
real HTTP requests. Its DNS lookup gives Node the browser's `.localhost`
resolution behavior; it does not mock a Worker or call the private resolver.
It checks bare/app-prefixed platform hosts, hyphenated slugs, full-slug
precedence, the custom apex and arbitrary custom labels, unknown-host
rejection, preserved URL/query, canonical context and stripped forged hints.

```sh
WORKER_BASE_URL=http://localhost:8799 \
  pnpm --dir packages/v3/project-core exec node --test e2e/hostnames.test.ts
```

Current local suite: **43/43 passed**, no skips/failures/cancellations, in
38,612.068625 ms. Typechecking, lint and formatting also pass. Current size is
**3,789 raw implementation lines**, **2,053 E2E lines** separately. The root
`envs.ts` also adds a three-line re-export of the isolated deployment map.

## Isolated public domain deployment

The proof is deployed to **https://iterate2.com**, with project hosts such as
`demo.iterate2.com` and `docs--demo.iterate2.com`. The separate owned zone
**iterate.computer** demonstrates a customer apex and arbitrary app labels,
including **https://anything.iterate.computer**. All select the existing
context and one policy; the DNS label does not create another context.

Both zones had empty DNS and Worker-route inventories before this deployment.
Four new proxied CNAME records point to
`iterate-project-core-domain-poc.iterate.workers.dev`:

| Record               | Created UTC     | Record ID                          |
| -------------------- | --------------- | ---------------------------------- |
| `iterate2.com`       | 12:03:36.460972 | `d76857ead2fa107f60ad1dc5aafc64c6` |
| `*.iterate2.com`     | 12:03:37.464270 | `b75d45af2ae1d9ab9a68b0a04451488f` |
| `iterate.computer`   | 12:03:38.442682 | `c538b00c1491e8cdf1a31ead779e92a4` |
| `*.iterate.computer` | 12:03:39.503194 | `f19c9c5dd687269d3973b5bbf943be38` |

The four matching `host/*` Worker routes and active apex/wildcard Universal
TLS certificates are present. Public recursive and authoritative DNS answers
were positive; HTTPS certificate verification succeeded. Existing Workers,
DNS records and routes were not replaced. The reserved preview-slot-20
domains and the separate `iterate2.app` deployment were left alone.

This proves routing through two owned zones, **not** self-service Cloudflare
for SaaS customer-domain verification/provisioning. The typed resource map is
[`deployment.ts`](../deployment.ts); the guarded generator writes ignored
Wrangler configs for the new stack only:

```sh
doppler run --project _shared --config prd -- \
  node packages/v3/project-core/scripts/generate-domain-wrangler-config.ts --env domain_poc
```

Run the public hostname test with the real DNS and TLS paths:

```sh
WORKER_BASE_URL=https://iterate2.com \
  E2E_PROJECT_HOSTNAME_BASE=iterate2.com \
  E2E_CUSTOM_HOSTNAME=iterate.computer \
  E2E_DNS_SERVER=1.1.1.1 \
  pnpm --dir packages/v3/project-core exec node --test e2e/hostnames.test.ts
```

Remote hostname tests fail explicitly if these domain inputs are missing;
they do not silently skip. The remote client queries actual DNS directly
(optionally choosing `E2E_DNS_SERVER`) and connects with the requested hostname
and normal TLS verification. It does not use a fixed-IP override. The first
run at 12:05:30–12:05:34 failed because macOS `getaddrinfo` still returned
`ENOTFOUND` while both public and authoritative DNS had positive answers.
No system DNS cache flush or hosts-file edit was performed.

## Runtime comparison and current acceptance

After that client-side DNS issue, the named-HTTP-loader version
`7c9f1dd2-5d74-4a45-b3ab-b3577aab3055` failed the actual network assertion
twice: `anything.iterate.computer` at 12:11:03 UTC, then the custom apex at
12:18:55 UTC. Both returned HTTP 500 / Cloudflare 1101 after platform-host
cases passed. The first exact error is `Unable to deserialize cloned data due
to invalid or unsupported version.` These remain recorded failures, not DNS
failures or passed tests.

The controlled change uses fresh native loading for both HTTP policy and
destination workers, preserving native streaming/upgrade responses. Named RPC
loading and the separate inert build cache remain intact. The public API and
hostname maps did not change. Version
`c92cb530-0b2c-497d-b7b9-1c6eb89c62c0` passed the full hostname case **1/1**
at 12:20:35.420–12:20:38.512 UTC, 2,524.312292 ms test / 2,816.804084 ms total.
This is evidence for the loader-boundary choice, not a proven V8 root cause
or a measured runtime-cache performance equivalence. Full-suite and telemetry
acceptance are recorded separately in [domain-preview.md](domain-preview.md).

The browser walkthrough on the new dashboard also proved email-entry login,
live follow, one unsigned and one signed append (L0/L1), replay through offset
2, inspect, the fetch-policy tutorial, and explicit follow shutdown, with no
browser console errors. The identity `domain-proof@example.com` was deliberately
unverified demo input, not a real user's account.

A direct browser navigation to `https://anything.iterate.computer/notes?q=1`
also returned the exact project context, preserved URL and `anything` app
hint, with no browser errors. Two subsequent 40-request alternating-host
samples had no response mismatches; [hostname-latency.md](hostname-latency.md)
records their connection modes and timing limits. Those client timings are
not a claim about the native loader's isolated cost.
