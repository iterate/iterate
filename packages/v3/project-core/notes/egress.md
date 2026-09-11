# Egress: secret and human gate contract

`Egress` owns two private Durable Object tables. `egress_secrets` contains only
AES-GCM ciphertext, nonce, canonical HTTPS origin, and revision. Its key is the
Wrangler `EGRESS_KEY` secret: base64url of exactly 32 random bytes. The key is
loaded lazily, so ordinary HTTPS egress with no secret can work without it;
secret encryption/decryption fails explicitly with `EGRESS_KEY` when absent.
It is never copied into event data, source, worker bindings, or logs.

Only the control-plane route may call `putSecret`. It must first validate
`Authorization: Bearer EXPERIMENT_ADMIN_TOKEN`; it is deliberately absent from
`Context.invoke`, `Scope`, `Host`, and all loaded-worker bindings. Public
bootstrap means untrusted code can otherwise exfiltrate anything it can call,
so production must establish an authentic owner and lock context trust before
secrets are configured.

The root integration supplies a mandatory, synchronous `platformAppend` that
appends into the ambient Durable Object transaction. `putSecret` uses an
encrypt-then-revision-CAS write, and commits ciphertext plus
`itx.system.secret.put` together; a concurrent update is an explicit
`SECRET_CONFLICT`, never a lost write. Approval requests similarly commit their
pending row and `itx.system.egress.requested` audit together. Audit data has
request id, fingerprint, policy offset, method, origin, body hash, secret name/revision and
expiry—never a secret value or request body. No callback means no Egress.

`Context.fetch` invokes the single installed `mount/fetch` policy for both
ingress and worker-originated fetches. There is no separate `egress` setting
and no default network permission: an absent policy returns
`404 FETCH_POLICY_UNCONFIGURED`. Privileged policy code explicitly selects
the network terminal through a native continuation:

```ts
const network = await env.NEXT.to({
  kind: "network",
  approval: { approval: "required", expiresInMs: 60_000 },
});
return network.fetch(request);
```

The same function can instead select `{ kind: "worker", source }` for an
internal destination. Ordinary apps receive contextual ITX but not NEXT by
default; their global `fetch()` re-enters that policy. See
[the one-fetch interface](one-fetch-interface.md). The network terminal adds
no second routing ruleset. Its requests are HTTPS, have at most a
1 MiB body, and bind policy offset, method, normalized URL, all normalized request headers
(including the platform `Headers` duplicate-header semantics), body hash, and
secret name/revision. A secret reference is exactly `{{secret:NAME}}` as an
entire header value. URL, query, and body substitution are forbidden; the
stored secret origin must equal the outbound origin. The terminal fetch uses
manual redirects. An application's outer `fetch()` may still follow a redirect;
that new request re-enters the gate and must independently satisfy its policy.
Following a secret-bearing redirect to another origin fails `SECRET_ORIGIN`.

“Write-only” describes the platform API, not information-flow tracking. An
allowed server can echo a credential in its response; the synthetic echo test
deliberately does that to prove substitution. A secret's origin must therefore
be a trusted recipient. A more restrictive connector can also bind path,
method, and response shape; origin restriction alone does not supply those
guarantees. No app receives the encryption key or a direct secret-read method.

With required approval, first submission returns `202 APPROVAL_REQUIRED` with
a fresh request id. The caller retries the _identical_ request with
`x-project-core-approval`; that header is removed before both fingerprinting
and outbound fetch. A committed ordinary `approval.decided` event needs data
`{requestId,fingerprint,allow:boolean}` and platform verification level 2.
Root combines `egress.prepare(input)` with its prepared append application and
calls the returned function with the actual committed record _inside_ the
stream transaction. Thus unknown, expired, duplicate, unsigned, and already
used decisions abort the ordinary event too; a false decision becomes a
durable denial. The retry marks its pending request consumed and appends
`itx.system.egress.released` in one SQL transaction before `fetch`.
Expired, mismatched, and repeated retries cannot issue an effect. A failed
outbound fetch does not release the consumed approval and is never replayed.

After asynchronous body preparation and trusted header injection, the owning
Context synchronously rechecks the installed policy offset. That check, the
atomic claim, and native fetch dispatch have no intervening `await`; the DO
output gate holds sending until the claim is durable. A replaced policy fails
with `FETCH_POLICY_CHANGED` before dispatch. `released` records a one-shot
dispatch attempt, not remote receipt or completion. Neither replacing policy
nor disposing a handle recalls an already dispatched external effect.

Rotation changes a request's fingerprint: retrying an approval for revision 1
after revision 2 is installed fails with `APPROVAL_MISMATCH`, before dispatch.
`SECRET_CHANGED` detects a changed revision when injection reads that secret;
this does not claim a final all-secret revocation check after asynchronous
decryption. AES-GCM associated data explicitly selects only domain, context,
name, origin and revision on both encryption and decryption; spreading the
stored row would accidentally authenticate its ciphertext and nonce too.

The seven original local-network egress E2Es use harmless GETs to `https://example.com/`
and a synthetic-secret HTTPS echo at `https://httpbin.org/`. Each creates its
own project and key names. They cover secret substitution, write-only control
and receipts, exact-request approval, tampering, denial, expiry, replay,
rotation, origin binding, and both manual and followed redirects. A second
identical approved retry observes `APPROVAL_USED`; this proves the platform's
one-use dispatch gate, not exactly-once execution at the remote provider.
The fixture uses a synthetic `EGRESS_KEY` and operator token; no product
credential is sent to the echo origin. Two newer cases prove approval invalidation
on policy replacement and replacement during a worker-controlled outbound
stream. All nine pass locally; see the [current verification command and precise limits](../evidence/one-fetch.md).
A separate [two-kill recovery probe](../evidence/egress-recovery.md) verifies
pending and decided approvals, durable one-use consumption, secret revision
invalidation, and post-restart decryption through public HTTP interfaces.
Deployed acceptance and provider-outcome reconciliation remain outstanding.
