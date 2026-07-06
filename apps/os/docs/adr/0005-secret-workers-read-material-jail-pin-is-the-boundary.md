# Secret Workers Read Material; The Jail Pin Is The Boundary

A secret may host one user-supplied stateless dynamic worker that overrides
the secret's `fetch()`. The worker **reads its own secret's material** and
composes ordinary requests with real bytes. Confinement is the jail — a
`globalOutbound` pinned to the secret's hosts, `connect()` rejected, env
constructed by the installing integration — not byte-hiding, and not output
inspection. Two tiers with one invariant: project-tier material may enter
the project's own jails; **platform-tier material never enters a jail or
any project-reachable code path**. First-party app credentials participate
only as header placeholders substituted en route under the platform
secret's own host pin (in practice: OAuth Basic client auth at token
endpoints), or the composing code is first-party in-process platform code.
Substitution is header-only, everywhere; bodies and WebSocket frames are
never scanned or substituted.

## The rejected alternative

A no-`read()` membrane was designed and verified buildable at workerd
source level (~100–130 lines): extend placeholder substitution into request
bodies and outbound WebSocket text frames at the jailed outbound, add a
`sign()` compute method, allow placeholders in `update()` material — so no
worker ever holds bytes and exfiltration becomes structurally impossible
(you cannot steganograph what you never had). Rejected because it makes
deep body/frame inspection load-bearing (content-type-aware
decode-substitute-reencode for form encodings, JSON escape tolerance, a
frame relay pump), i.e. a membrane framework, where the accepted design is
plain per-integration code — and because the exfiltration it prevents is,
for project-tier material, a _self-leak_: every jail exit (Response to
caller, capture append) lands inside the owning project. Output scanning
survives only as a tripwire (naive leaks fail loudly) and is documented as
losing to deliberate encoding.

## Consequences

- The trust event is install-time worker declaration by the project owner;
  the trust statement is "jail code can at worst leak the project's own
  material to the project itself."
- Rotating a first-party client credential is a Doppler change + deploy: no
  bytes are ever copied into connection secrets (copy-at-connect was
  rejected for exactly that fanout).
- Providers whose token endpoints refuse header client auth split by lane
  for that provider only: first-party refresh runs in-process (env +
  audited reveal), userspace reads its own app secret inside its own jail.
- If a future case genuinely requires platform bytes inside user-authored
  transport code (e.g. a platform credential that must appear inside a WS
  frame composed by userspace), that configuration is architecturally wrong
  (make it platform infrastructure) rather than a reason to build the
  membrane.

Design: `apps/os/docs/integrations-and-secrets-design.md` (v6, 2026-07-06).
