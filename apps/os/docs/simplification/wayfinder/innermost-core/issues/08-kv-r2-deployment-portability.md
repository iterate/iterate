# 08 — KV/R2 deployment portability (THE proof point)

Type: prototype
Status: open
Blocked by: —

Jonas: "a real proof point for our architecture." A project's code does `itx.kv.get("foo")` /
`itx.r2.get("bar")`. It must be **byte-identical** whether the project runs in a customer's BYO Cloudflare
account or in our finite-namespace hosted account.

## The answer (to prove): portability is a PROVIDER concern

`itx.kv` / `itx.r2` are **capabilities with a fixed interface**; the _provider_ encodes the deployment:

|                                        | provider backing                                                                     | isolation                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| **BYO account** (project "over there") | a **dedicated** KV namespace + R2 bucket created in _that_ account at provision time | the account itself                                                                          |
| **Hosted product** (our account)       | a **shared** namespace/bucket (we have a finite number)                              | the capability wrapper **prefixes every key with `<projectId>:`** (R2: `<projectId>/` path) |

The project **never sees the difference** — `itx.kv.get("foo")` is the same call; the hosted wrapper
transparently reads/writes `"<projectId>:foo"`. Isolation is enforced by the provider, invisible to code.
This is exactly the capability thesis: **interface fixed, provider varies, code portable** — "location is a
property of the provider" (D8) applied to storage.

## The proof to build (spike-5 candidate)

Same `itx.kv`/`itx.r2` consumer code, two providers:

- **Dedicated** provider → a real KV namespace (simulate/deploy the BYO case).
- **Shared+prefixed** provider → one namespace, `<projectId>:` prefix; prove two projects can't read each
  other's keys and neither can escape its prefix.
  Run BOTH against the SAME project code in real workerd + deployed. Green = the portability claim is real.

## Questions

- Who PROVISIONS the dedicated namespace in the BYO case? (the Alchemy-v2-style script, ADR 0010.)
- Is the shared+prefixed wrapper a control-plane capability the project falls through to, or config-local?
  (Probably control-plane-provided, so the _same_ project code falls through to whichever the deployment
  wired — the §8 fallthrough-by-name.)
- Does R2 need per-project bucket-level features (lifecycle, CORS) that prefixing can't give? (bucket limits
  vs object-prefix isolation — the real constraint.)
