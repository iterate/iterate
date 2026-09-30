# Sweep candidates: os-edge-api

Verified candidates from the 2026-09-29 codebase simplification sweep for this area. Each passed an adversarial skeptic check; where the skeptic amended the proposal, the amendment wins. Line numbers are as of origin/main on 2026-09-29 (about cfd8a1d36) and have drifted since: #3442, #3455 and #3460 touched some of these files. The index and the owner calls are in ../codebase-simplification-sweep.md.

## Consent has one door, the issuer page: drop /api's test-only `session.consent`, the admittedThisRequest flag and the drifted ConsentAnswer type

- Sweep index: 5; risk: low; payoff: 5/10
- LOC: Product: −72 net (+4/−76), measured on copies.
- packages/iterate api.ts: −40
- consent.ts: −16
- session.ts: −8
- rpc.ts: −6
- consent-page.server.ts: −4

Tests: about +10 net. Around 35 callsites move to the helper, and two e2e fixtures move to a form POST.

Net: about −60. (skeptic measured: I measured on copies of the five product files taken from wt-main (b3daf4846), keeping the constructor's issuer-kind check. Product is -72 net, with 80 lines deleted and 8 added:

- consent.ts: 507 to 493 (-14)
- consent-page.server.ts: 171 to 165 (-6)
- rpc.ts: 196 to 190 (-6)
- session.ts: 1342 to 1334 (-8)
- packages/iterate/src/api.ts: 1276 to 1236 (-40, which includes the now-unused ConsentScope import)

An optional extra of about -10 comes from dropping the zod re-parse in consent.ts: `#request` and approve's input schema, since the one in-process caller already passes parsed form data.

Tests: an estimated +10 to +20 net.

- Most callsites keep their line count (`approver.consent.approve` becomes `approver.approve`).
- issuer-bootstrap gains about +7 lines, one `const consent = ...` per row, and loses 7 lines of /api-only rows (:164-166 and :211-214).
- oauth.test.ts:840 grows about +5 to go through the worker.
- The e2e fixtures are roughly neutral: form POST in, HTTP-batch plus lint-disable out.

Overall about -55 to -60.

PR #3446 touches none of these files.)

- Concepts: 4 concepts become 2.
- Before: 2 doors, 2 view types, and 1 mode flag.
- After: 1 door and 1 type.

### Evidence

Merges the parallel and heavy hunts.

The page's door:

- apps/os/src/consent-page.server.ts:64-66 and :161-163 build a ConsentRpcTarget with `admittedThisRequest: true`. Consent has been server-side since #2853.

The /api door:

- rpc.ts:41-45 builds one per issuer-grant connection with `admittedThisRequest: false`.
- session.ts:445 and :571-575.

The flag exists only to tell the two doors apart: consent.ts:179-216 (:185-210 is the flag and the extra `grantIsLive` re-read).

The published type has drifted:

- packages/iterate/src/api.ts:1050-1077 `ConsentAnswer` is missing clientId, clientLogoUri, clientDomain, picture and impersonation.
- :1150-1159 declares the door.

No client uses the /api door:

- `git grep '.consent.'` across apps/dash, agents, kit, packages/cli and packages/iterate finds no caller.
- The ~35 callers are workers tests (issuer-bootstrap 15, admin-and-impersonation 8, admin-sign-in 5, oauth 3, oauth-support 1, project-host-sign-in 1) and two e2e fixtures (e2e/support/principal.ts:49-55, iterate-cli.e2e.test.ts:77-85).

### Current shape

Consent can be described and approved through two doors:

- the issuer page's server functions and form POST, which is the product;
- `session.consent` over /api, which only tests call.

Supporting both takes a per-connection RpcTarget, a flag that decides whether to re-read the grant, and a second published view type that has drifted from ConsentView.

### Proposed shape

`ConsentRpcTarget` becomes a plain `class Consent` with no RpcTarget and no flag. Only consent-page.server.ts uses it.

Delete:

- `SessionAuthority.consent` and `SessionRpcTarget.consent`
- rpc.ts's consent branch
- `IterateApi.consent` and `ConsentAnswer`

Test changes:

- Workers tests use a helper, `consentFor(cookie) => new Consent(env, ctx, (await browserAuthorization(env, req)).grant, addresses)`.
- e2e fixtures POST the page's form and read the 303 Location:

`fetch(workerUrl('/oauth2/auth' + flow.url.search), { method: 'POST', redirect: 'manual', headers: { Origin, Cookie }, body: new URLSearchParams([['project', id], ['scope', 'iterate']]) })`

### What changes

- No Cap'n Web client can describe or approve an OAuth consent any more. No shipped client does.
- Only same-request admissions remain, so the extra grant re-read goes away.
- The SDK loses `consent` and `ConsentAnswer`, with no backcompat.
- e2e consent now goes through the real form path.

### Pinned by

- **workers-tests**/: issuer-bootstrap.test.ts (including :211-212, which is deleted), admin-and-impersonation, admin-sign-in :60-121, oauth, oauth-support.ts:57 and :174, project-host-sign-in
- e2e/support/principal.ts `oauthSession`
- e2e/iterate-cli.e2e.test.ts `consented`

### Skeptic's amended proposal

Delete the /api path to consent and keep a single in-process class.

**consent.ts**

- `export class Consent` (no `RpcTarget`) with constructor `(env, ctx, grant, addresses)`.
- Keep the 2-line `grant.kind !== "issuer"` FORBIDDEN check as a second copy of the check `issuerSignIn` already makes.
- Delete `#admittedThisRequest`, its doc comment, the `grantIsLive` re-read and its 4-line comment, and the `grantIsLive` and `RpcTarget` imports.
- Optional (about -10): `describe(query: string)` and `#request(query: string)` without `z.string().parse`. Also drop approve's input zod schema, moving `impersonate: z.string().startsWith("user_")` into consent-page.server.ts `ConsentApproval`. That turns today's uncaught ZodError (a 500 on the form POST) into a plain validation failure.

**consent-page.server.ts**

- `const view = await new Consent(env, ctx, signedIn.grant, addresses).describe(authorization);`
- `const approved = await new Consent(env, ctx, signedIn.grant, addresses).approve({...});`
- Remove the `admittedThisRequest` clause from approveConsentForm's doc.

**Other product files**

- rpc.ts: drop the import and the 5-line issuer spread in `authorityOf`.
- session.ts: drop the type import, `SessionAuthority.consent` and `get consent()`.
- packages/iterate/src/api.ts: drop `ConsentAnswer`, `IterateApi` session `consent`, and the now-unused `ConsentScope` import.
- oauth-scopes.ts:31: the comment says "sent with the consent page's view" instead of naming `consent.describe`.

**Workers tests**

- oauth-support.ts `issuerApprover(cookie)` returns `new Consent(env, createExecutionContext(), (await browserAuthorization(env, req))!.grant!, platformAddressesOf(env, req))`. Callers drop `.consent`.
- issuer-bootstrap rows add `const consent = await issuerApprover(cookie)`.
- Delete :164-166 (covered by oauth.test.ts:295) and :211-214. Optionally replace the latter with one row: `expect(() => new Consent(env, ctx, appGrant, addresses)).toThrow(/Sign in to iterate/)`.
- oauth.test.ts:840 must stay in the worker: GET `/oauth2/auth?q` with the cookie to fill the cache and assert the slugs in the HTML, form-POST to approve (as at :305-315), then GET again.

**e2e fixtures (principal.ts `oauthSession`, iterate-cli.e2e `consented`)**
Post the page's form and read the 303 Location, posting every requested scope. The CLI's tokens step-up asks for `iterate account`.

```ts
const body = new URLSearchParams([
  ["project", id],
  ...flow.url.searchParams.get("scope")!.split(" ").map((s) => ["scope", s]),
]);
const res = await fetch(workerUrl(`/oauth2/auth${flow.url.search}`), {
  method: "POST",
  redirect: "manual",
  headers: { Origin, Cookie },
  body,
});
const location = res.headers.get("location");
if (res.status !== 303 || !location?.includes("code=")) throw new Error(...);
```

**Wording:** keep "door" out of code, comments, test titles and the PR text (rules/terminology/no-metaphorical-lane-door-seam.md).

### Skeptic's verdict

The claim holds up against the code.

**Consent is only ever reached two ways.**

- `oauth2.auth.tsx` uses only `describeConsent` and `approveConsentForm` in consent-page.server.ts.
- `session.consent` over /api has no caller in apps/dash, admin, agents, kit, packages/cli, packages/iterate, specs or scripts.
- `git grep` finds only workers tests and two e2e fixtures (principal.ts:49-55 and iterate-cli.e2e.test.ts:77-85). Both fixtures need `no-capnweb-http-batch` lint-disables that would go away.

**Why the flag exists.**

- `admittedThisRequest` was added in #3124 only so the page path could skip the second `grantIsLive` read.
- The re-read and its 4-line comment exist only because a socket or batch outlives its admission.
- Remove the /api path and the flag, the re-read, the `RpcTarget` base, `SessionAuthority.consent`, `SessionRpcTarget.get consent`, rpc.ts's issuer spread and the published type all go.
- The page's behaviour is byte-for-byte unchanged, because it already passed `true`.

**The published type really has drifted.**

- `ConsentAnswer` lacks clientId, clientLogoUri, clientDomain, picture and impersonation on the consent variant, and the logo and domain on identify.
- The published `approve` signature also lacks `scopes`.

**Every behaviour that changes:**

1. /api sessions lose describe/approve. No product client uses them.
2. The SDK drops `IterateApi.consent` and `ConsentAnswer` with no backcompat. That breaks the SDK, but nothing in the repo uses them.
3. The /api-only re-read disappears along with the only path that needed it.
4. An issuer bearer can no longer mint grants over /api without the page's Origin-checked form. This tightens security; it does not loosen it.
5. Tests pinned to /api-only behaviour change:
   - issuer-bootstrap :164-168 ("session has ended" after logout) goes. The page's version is already pinned by oauth.test.ts:295.
   - :211-214 (an app grant refused consent) becomes vacuous on /api. The same wall is `issuerSignIn`'s `kind !== "issuer"` check plus the constructor check I would keep.

**No guarantee is lost.** The Origin check, reading the form before admission, issuer-only approval and the #impersonate audit records all stay.

**Mis-specifications in the candidate.**

- (a) Tests that build `new Consent` inside the test module stop exercising the worker's catalog cache. oauth.test.ts:840 exists to prove a project created on another isolate is listed and approvable within the 5 s cache window. `controlPlane().createProject` calls `#forget` on the test module's cache, so an in-module Consent passes vacuously. That row must go through the worker:
  - GET `/oauth2/auth?q` with the cookie, to fill the worker's cache and list;
  - the form POST, to approve (the pattern at oauth.test.ts:305-315);
  - GET again, to list.
- (b) The e2e sketch posts only `scope=iterate`. The CLI's `tokens` step-up requests "iterate account" (packages/cli/src/cli.ts:158; asserted at iterate-cli.e2e.test.ts:124), and the form grants only the scopes it posts. The fixture must post every requested scope.
- (c) The candidate's text uses "door", which rules/terminology/no-metaphorical-lane-door-seam.md forbids in code, comments and test titles.

**Is it simpler?** Yes: fewer concepts and fewer lines. What is left is one class called from one file with one view type.

**Small costs:**

- A failed e2e consent now comes back as a 303 to the page, not a JSON error, so the fixture's error message is less useful.
- The tests run consent in the test module; first-account-read.test.ts already calls `describeConsent` this way.

## The operator secret has one door at /api (`admin-secret`), not also an OAuth bearer that needs a nullable grant

- Sweep index: 6; risk: low; payoff: 5/10
- LOC: - Product: −28 net (+10/−38 across oauth.ts, rpc.ts, grants.ts, mcp.ts and api.ts), measured on copies.
- consent-page.server.ts: −1.
- docs: about −4.
- tests: about −10. (skeptic measured: I applied the edits to copies of the 9 product files in a scratch git repo. `git diff --stat` gives 25 insertions and 56 deletions, so -31 net, comments included:
- oauth.ts: +7/-31
- rpc.ts: +7/-11
- grants.ts: +2/-3
- caller.ts (comment): +2/-3
- consent-page.server.ts: +1/-2
- worker.ts: +2/-2
- api.ts, mcp.ts and secret-oauth-callback.ts: +1/-1 each
- identity.ts: unchanged

Estimated beyond that:

- Docs: about -8 (credentials.md:99-110 loses its four-bullet refusal list; small trims in dev-environments.md:223-224 and setup-prompt.md:74).
- Tests: about -9 net. The oauth.test.ts, personal-access-tokens.test.ts and session.e2e.test.ts rows shrink by about 16. The two e2e rows the candidate missed grow by about 7.

Total is about -45.)

- Concepts: 3 concepts become 1.
- Before: 2 spellings of the operator credential, a nullable-grant Authorization, and a dedicated refusal reason.
- After: 1 spelling and an always-granted Authorization.

### Evidence

The same secret gets in two ways:

- apps/os/src/session.ts:138-154: `authenticate({ type: 'admin-secret', secret, as? })`.
- oauth.ts:229-242: `validateToken` also admits `secrets.adminBearer`, both as the Authorization header and as an in-band `{ type: 'bearer' }`.

Code that exists only to fence the second door:

- oauth.ts:285-288 (`operator_bearer_not_accepted`)
- oauth.ts:75-76 (`grant: AccessGrant | null`, 'Null only for the configured administrator credential')
- rpc.ts:103-104
- grants.ts:106
- consent-page.server.ts:21-22

Every operator tool already uses admin-secret: packages/cli/src/cli.ts:138-139, apps/os/scripts/preview-readiness.ts:166, project-seed.ts:45, control-plane-load.ts:40, seed-instance-secrets.ts:62, scripts/ci/context-sweep.ts:180, apps/agents/scripts/client.ts:11, examples/serve-localhost.mjs:25, e2e/support/client.ts:47, specs/test-support/operator.ts.

### Current shape

`secrets.adminBearer` is accepted at /api two ways:

- in-band admin-secret, which supports `as`;
- an ordinary OAuth bearer, which mints an Authorization with `grant: null`.

That null grant then needs explicit refusals at /mcp, project hosts, browser sessions and OAuth callbacks, plus `?.grant` guards throughout.

### Proposed shape

- Delete the bearer branch in `validateToken` (oauth.ts:229-242) and the `!grant` refusal (:285-288).
- `Authorization.grant` becomes a non-null `AccessGrant`.
- rpc.ts, grants.ts, mcp.ts, api.ts and worker.ts drop their `grant?.` guards.
- docs/credentials.md says the secret is never a bearer.

### What changes

A bearer or in-band `bearer` carrying the admin secret at /api is refused (401 / INVALID_CREDENTIALS) instead of admitting `{ actor: 'admin' }`.

The refusal everywhere else stays. It is now logged `token_unknown_or_expired` instead of `operator_bearer_not_accepted`.

HTTP-batch operator calls need a socket with admin-secret. No tool makes them.

### Pinned by

- **workers-tests**/oauth.test.ts:85-103
- **workers-tests**/personal-access-tokens.test.ts:257-268
- e2e/session.e2e.test.ts:475-491 (HTTP batch with the operator bearer)
- control-plane.test.ts:383/591 and secrets-connections.e2e.test.ts:365 assert refusals, which stay true.

### Skeptic's amended proposal

**One PR in apps/os.**

**Product:**

- Delete oauth.ts:229-242 (the `verifyAdminSecret` branch in `validateToken`, and its import) and :285-288 (the `!grant` fence).
- Make `Authorization.grant: AccessGrant`, non-null, and change `personalAccessTokenAdmission`'s return to plain `Authorization`.
- rpc.ts:
  - delete :103-104, the operator socket shortcut;
  - `bindSocket` becomes `if (stopped) return; release = holdGrantLease(env, authorization.grant, …)`;
  - `authorityOf` and the same-grant check read `authorization.grant.*` directly;
  - `recordGrantUse` runs unconditionally at :80.
- grants.ts: drop the `endCurrent` null throw at :106 and the `?.` at :65 and :78.
- api.ts:116: `recordGrantUse` runs unconditionally.
- worker.ts:378 becomes `if (stamped)`, :382 becomes `stamped?.grant.grantId`, :419 becomes `bearer && stamped`.
- mcp.ts:112 becomes `grant.grantId`.
- secret-oauth-callback.ts:143 becomes `grant.scope.includes('account')`.
- consent-page.server.ts:21-22 becomes `return signedIn?.grant.kind === 'issuer' ? signedIn : null;`.
- Trim the caller.ts:265 comment and the oauth.ts validator and `authorizationForToken` docstrings to one line: "the operator's secret is no bearer; /api verifies it in-band".

**Docs:**

- credentials.md: the table row and :99-110 say the secret is accepted in-band at /api only, and the refusal bullets go.
- dev-environments.md:223-224 and public/setup-prompt.md:74 get the same trim.

**Tests:**

- **workers-tests**/oauth.test.ts:85-103: take the admin whoami from `actingAs()`. Assert /mcp gives 401 with the reason `token_unknown_or_expired`, or drop the warn spy.
- personal-access-tokens.test.ts:257-268: `authorizationForToken(operator, …)` is null at all four entry points, `api` included.
- e2e/session.e2e.test.ts:475-491: /api, /mcp and a project host all answer 401 to the operator's secret as a bearer.
- e2e/library-connectors.e2e.test.ts:235-242 and e2e/workers-and-facets.e2e.test.ts:250-285: dial with a member's OAuth token for a registered project (`registerProject(freshDnsSafeProjectSlug(…), member)` plus `oauthSession(id, member)`, then `authenticate({ type: 'from-server-cookie' })`) instead of the operator header.
- These refusal assertions stay as they are: control-plane.test.ts:383 and :591, secrets-connections.e2e.test.ts:366, e2e/support/integrations.ts:51.

### Skeptic's verdict

The candidate holds, but it undercounts which tests pin the current behaviour.

**(a) Semantics.** A secret-to-null-grant `Authorization` is built in exactly one place, oauth.ts:229-242 (`git grep "grant: null"` finds only that line). The whole nullable-grant type and its guards exist for that one branch. Every in-repo tool reaches the operator through in-band `admin-secret`, all through `connectIterate` or a bare socket:

- the CLI
- preview-readiness, preview.ts, project-seed.ts
- control-plane-load.ts, seed-instance-secrets.ts, getin.ts
- context-sweep.ts, apps/agents client.ts
- specs/test-support/operator.ts, the e2e client

No `.depot` workflow sends it as a header. The `operator_bearer_not_accepted` reason came in with #3048. The lint-disable comment at session.e2e.test.ts:484 says the header form is used "as the e2e harness and deploy gates use /api". That is no longer true: they use the socket.

Every behaviour that changes:

1. `Authorization: Bearer <secret>` at /api (an HTTP batch or a WebSocket upgrade) gets 401 instead of `{ actor: 'admin' }`.
2. In-band `authenticate({ type: 'bearer', token: secret })` gets INVALID_CREDENTIALS.
3. At /mcp, /oauth2/userinfo, project hosts, browser sessions and the secret OAuth callback it is still refused. The log reason becomes `token_unknown_or_expired`, and the refusal costs one extra KV read (`unwrapToken`). Nothing else reads the reason string.
4. The operator can no longer make a one-shot HTTP batch at /api, because a bare HTTP request stays behind the 401 gate (api.ts:43-54).

**Tests the candidate missed.** Two e2e rows use exactly that header door:

- e2e/library-connectors.e2e.test.ts:235-242: a context self-dials /api by batch with the operator header plus in-band `admin-secret`.
- e2e/workers-and-facets.e2e.test.ts:250-285: a userspace worker does the same.

These are about how the dial works, not about the operator. They need a person's bearer for a registered project instead: `registerProject(slug, member)` plus `oauthSession(id, member)`, then `authenticate({ type: 'from-server-cookie' })`. That is about +3 to +4 lines each. The WebSocket variant cannot replace them locally, because local wrangler has no outbound WebSocket, which is why it is `deployedOnly`. apps/os/bench/api.bench.ts:26 sends a batch with no header at all, so it is already broken either way.

**(b) Simpler, not just different.** `Authorization` becomes exactly "a live grant's admission". Several things go:

- the special socket path in rpc.ts:103-104 (`newWorkersRpcResponse` with no lease and no teardown);
- the null checks in rpc.ts, grants.ts, api.ts, worker.ts, mcp.ts, consent-page.server.ts and secret-oauth-callback.ts;
- the explicit fence in `authorizationForToken`;
- the `Authorization & { grant: AccessGrant }` narrowing type at oauth.ts:469, which is now redundant;
- the four-bullet section in credentials.md.

**(c) Guarantees.** None is dropped, and security improves. Keeping the secret off every entry point except in-band /api now follows from the code's shape instead of depending on a per-entry-point `!grant` check that a new entry point could forget. The secret also stops travelling in Authorization headers. Loop limits, leases and revocation are untouched: every grant-bearing path was already leased, and in-band `admin-secret` was already unleased.

**Risk.** Low. The only unknown is an operator script outside the repo that uses the header form, which the docs currently advertise ("or as a bearer").

## Project creation's slow-step timer class goes; watchSlowStep already does the job

- Sweep index: 7; risk: low; payoff: 3/10
- LOC: session.ts: −41 net (+42/−83, measured on a copy). Most of the added lines are the re-indented body. (skeptic measured: I applied the proposal to a scratch copy (scratchpad/skeptic-create/session.ts) with a 2-line comment and the import added. session.ts goes from 1342 to 1302 lines: -40 net (+43/-83 by git diff --no-index --numstat). The formatter will probably wrap the template line, so the real figure is about -37 to -40. sign-in-watch.ts does not change.)
- Concepts: 2 slow-step loggers and 2 thresholds become 1 of each.

### Evidence

Merges the parallel and heavy hunts.

- apps/os/src/session.ts:311-346: `SLOW_CREATE_MS = 5_000` and `class CreateWaits { time(); report() }`, from #3113.
- Its one user is `ProjectCollectionRpcTarget.create` at :1067-1115. That method needs a try/finally, a `let project`, and five `waits.time(...)` wrappers.
- sign-in-watch.ts:19-33 `watchSlowStep` does the same job with the same 5 s threshold, as a live watchdog.
- watchSlowStep is already used by oauth.ts:122, oauth-store.ts:45, issuer-session.ts and every sign-in step.
- No test or tool reads `session.project-create-slow`.

### Current shape

Two mechanisms log that a step was slow:

- `CreateWaits` times every creation step and, in a finally, logs one summary when the whole creation took 5 s or more.
- `watchSlowStep` logs any step still pending at 5 s, while it waits.

### Proposed shape

```ts
const slow = <T>(step: string, work: Promise<T>) =>
  watchSlowStep({ event: 'session.project-create-slow', step, project: data.project }, work);
const created = await slow('controlPlaneCreate', sessionInput.controlPlane.createProject(caller, {...}));
await slow('projectEnable', context.invoke(['itx', 'processors', ['enable', 'project']]));
```

Delete `CreateWaits` and `SLOW_CREATE_MS`, the try/finally, and `let project`.

### What changes

- One line per step still pending at 5 s, instead of one summary after the fact.
- A creation that is slow only in total, with every step under 5 s, no longer logs.
- A step stalled past the client's cancellation now logs. Today's `finally` never runs in that case.
- The fields change from `{ ms, slowest, steps, projectId, orgId }` to `{ step, waitedMs, project }`.

### Pinned by

Nothing pins the old logger: no test reads `session.project-create-slow`. sign-in-watch.test.ts pins watchSlowStep.

### Skeptic's amended proposal

In ProjectCollectionRpcTarget.create (apps/os/src/session.ts), delete `SLOW_CREATE_MS`, `class CreateWaits`, the try/finally and `let project`. Import `watchSlowStep` from ./sign-in-watch.ts and wrap each awaited step:

```ts
// A step still pending after five seconds logs `session.project-create-slow` while it waits:
// a brand-new Durable Object's first call or first write logs nothing of its own.
const slow = <W extends PromiseLike<unknown>>(step: string, work: W) =>
  watchSlowStep({ event: "session.project-create-slow", step, project: data.project }, work);
const created = await slow("controlPlaneCreate", sessionInput.controlPlane.createProject(caller, {...}));
await slow("projectEnable", context.invoke(["itx", "processors", ["enable", "project"]]));
await slow("projectRequest", context.invoke([...create-requested...]));
await slow("everyProjectLends", borrowEveryProjectLends(sessionInput, created.id, caller));
```

The template pin is wrapped the same way. Alternatively, export `watchProjectCreateStep(step, work)` beside `watchSignInStep`.

What changes:

- It logs per step while the step is pending, not once as a summary afterwards.
- A creation slow only in total no longer logs.
- `waitedMs` is the threshold (about 5000), not the stall's length, and the per-step times go. The total stays in the invocation's wall time and in traces.
- `projectId` and `orgId` become the input name.
- A stall past the invocation's cancellation now logs.

LOC: about -40 net, all in session.ts.

### Skeptic's verdict

The claim holds, but the candidate understates what changes.

**Why there are two mechanisms.** `CreateWaits` (session.ts:311-346) arrived in #3113. `watchSlowStep` became the shared, exported helper in #3131, which carries the same commit timestamp as #3113 (2026-09-25 00:50). So the two concurrent PRs each built a slow-step logger. Two mechanisms with one job is exactly the smell being hunted.

**Checks against the real code:**

- `CreateWaits` has exactly one user: `ProjectCollectionRpcTarget.create`, session.ts:1067-1115.
- Nothing reads `session.project-create-slow`: git grep finds it only in session.ts. No test, perf script, skill or doc uses it, and no test spies on it.
- PR #3446 does not touch session.ts.
- `watchSlowStep` already serves oauth.ts:122, oauth-store.ts:45 and every sign-in step. sign-in-watch.test.ts pins it.
- `create` runs in the edge session, so a watchdog timer that is cleared in `finally` costs nothing.

**What the new shape removes:**

- a class
- the `SLOW_CREATE_MS` constant
- the try/finally
- the mutable `let project` and its `project = created` assignment
- one level of indentation across the whole method body

It leaves one mechanism and one threshold. It is truly simpler, not just different.

**Every behaviour that changes (the "almost"):**

1. **Trigger.** Today the line fires when the whole creation took 5 s or more, answered or thrown. After, it fires for each step still pending at 5 s. A creation that is slow only in total, such as 3 s plus 2.5 s across steps, no longer logs. The docstring's stated purpose is to name the one Durable Object that stalled, and a single-step stall still logs.
2. **Durations, which the candidate did not call out.** `waitedMs` is taken when the watchdog fires, so it always reads about 5000. The line no longer says how long the stall lasted (#3113 saw 21.9 s and 13.4 s), and it no longer carries `steps`, `ms` or `slowest`. The total is still in the invocation's wall time in Workers Logs, and each call's length is in traces. The sign-in and oauth lines already accept the same trade-off.
3. **Identifiers.** `projectId` and `orgId` become the input's `project` name. They could be added back on the steps after `controlPlaneCreate`, but that isn't worth it.
4. **Line count.** Two stalled steps now give two lines instead of one summary.
5. **Cancelled invocations.** A step that stalls past the invocation's cancellation now logs while it waits. Today's `finally` does not run in that case, so this is a gain.

**Guarantees.** None is dropped. Nothing is retried or bounded, and #3113 itself says this line is "not a heal or a bound".

**Amendments to the sketch:**

- Type the local helper to match `watchSlowStep`'s generic: `<W extends PromiseLike<unknown>>(step: string, work: W)`, or take `Promise<T>`, which every call site already returns.
- Keep a two-line comment: "a step still pending at 5 s logs `session.project-create-slow` while it waits; a brand-new DO's first call or first write logs nothing itself". That keeps the one useful fact from the deleted docstring.
- Optionally export `watchProjectCreateStep` beside `watchSignInStep` instead of a local lambda, following that file's existing convention.

**Risk:** very low. It is a log line with no consumers.

**Payoff:** small. About 40 lines and one concept, in a central file, but it is logging code.

## MCP holds the session an /api client would, instead of re-implementing the session's project handle

- Sweep index: 8; risk: medium; payoff: 4/10
- LOC: −18 net (+40/−58 across mcp.ts and api.ts, measured on copies). (skeptic measured: I applied the change to copies in scratchpad/mcpcand and measured with `git diff --no-index --numstat`. mcp.ts goes from 218 to 202 lines (+39/−55). api.ts goes from 162 to 160 (+1/−3), because `resourceServer(addresses, addresses.mcp, mcpResponse)` replaces the wrapping lambda. The describeReach amendment in control-plane/edge.ts is +1/−1. Source net is −18. Five test assertions change their expected text, with no net line change: oauth.test.ts:114 and :369, personal-access-tokens.test.ts:110, issuer-bootstrap.test.ts:133 and e2e/mcp-project-root.e2e.test.ts:180.)
- Concepts: Before: 3 project-reference resolvers, plus MCP's own caller and its own dispatch.
  After: 2 resolvers, with MCP acting as a session.

### Evidence

- apps/os/src/mcp.ts:20-53 `projectOfToolCall` copies session.ts:1126-1146 `projects.get` step for step. Its own comment at :32 says "the same refusal as projects.get (session.ts)", but the messages have drifted.
- session.ts:1157-1168 `projects.delete` spells the same check a third time.
- mcp.ts:112 hand-builds a `Caller`.
- mcp.ts:160-164 calls `contextStub` directly, which is what `IterateContextRpcTarget.invoke` already does (iterate-context.ts:186-196).
- The header at mcp.ts:14 claims MCP uses 'the same authorization and project root as a Cap'n Web project handle'.

### Current shape

An MCP tool call resolves its project with a private copy of the session's project guard, then calls the root Durable Object with a hand-built caller.

### Proposed shape

```ts
const session = new SessionRpcTarget(
  { contextNamespace: env.ITERATE_CONTEXT, waitUntil: (p) => ctx.waitUntil(p), controlPlane, appConfig: appConfigOf(env), platformOrigin, cause },
  new SessionTeardown(), { principal, grant: grant?.grantId, reach });
let project = toolArguments.project?.trim();
if (!project) { const ids = (await session.projects.list()).map((p) => p.id); if (ids.length !== 1) throw new Error(...); project = ids[0]!; }
const value = await (await session.projects.get(project)).invoke(['itx', ['run', toolArguments.script]]);
```

This deletes `projectOfToolCall`, the hand-built caller and the direct contextStub import. `scopes` is left out, so the call carries no `account` flag, as today.

### What changes

- Refusal texts become the session's. For example, 'outside this token's grant' becomes 'outside this session's reach — …'.
- Retry lines log under area `itx` instead of `mcp`.
- With no `project` given, the reachable list is read fresh rather than taken from the isolate memo.
- The answer passes through materializeItxHandleReference, which does not change JSON.

### Pinned by

- **workers-tests**/oauth.test.ts:105-121 pins the exact MCP refusal text.
- e2e/mcp-project-root.e2e.test.ts
- **workers-tests**/personal-access-tokens.test.ts (MCP with a key)

### Skeptic's amended proposal

MCP holds the session an /api client would, and the proposal is amended in three ways.

(1) Build the session once per server in buildServer. Thread `ctx` through `mcpResponse(request, env, ctx, authorization)` so api.ts passes `mcpResponse` directly.

```ts
const session = new SessionRpcTarget(
  {
    contextNamespace: env.ITERATE_CONTEXT,
    waitUntil: (p) => ctx.waitUntil(p),
    controlPlane,
    appConfig: appConfigOf(env),
    platformOrigin,
    cause,
  },
  new SessionTeardown(),
  { principal, grant: grant?.grantId, reach }, // no scopes: no `account` flag, as today
);
```

(2) In the tool, keep MCP's own single-project default on the kept read, not `projects.list()`. That call reads fresh and would add a D1 round trip to every call made without a project.

```ts
let project = toolArguments.project?.trim();
if (!project) {
  const reachable = (await controlPlane.reachableProjects(reach)).map((row) => row.id);
  if (reachable.length !== 1)
    throw new Error(
      reachable.length
        ? `pass project — this token reaches ${reachable.join(", ")}`
        : "this token reaches no project",
    );
  project = reachable[0]!;
}
const value = await (
  await session.projects.get(project)
).invoke(["itx", ["run", toolArguments.script]]);
```

This deletes `projectOfToolCall`, the hand-built caller and the imports of contextStub, DurableObjectNameCodec, GLOBAL_PROJECT_ID and codedError.

(3) Fix `describeReach` (control-plane/edge.ts:46) so a user reach narrowed by `projectIds` is described as bound to those projects. Branch on `"userId" in reach && !reach.projectIds` and use `reach.projectIds?.map(...)` in the else branch. Otherwise the inherited refusal tells a consent-narrowed grant or PAT that it reaches "the projects of the orgs X belongs to" when the refused project is in that org. This also fixes /api's message.

Then update the five pinned assertions: oauth.test.ts:114 (exact text; switch it to /deployment-global namespace/ as the /api assertion two lines above does), oauth.test.ts:369, personal-access-tokens.test.ts:110, issuer-bootstrap.test.ts:133 and e2e/mcp-project-root.e2e.test.ts:180 (/outside this session's reach/).

### Skeptic's verdict

The duplication is real. mcp.ts:20-53 `projectOfToolCall` repeats the session.ts:1126-1146 `projects.get` guard step for step: codec parse, path must be "/", refuse GLOBAL_PROJECT_ID, then `reachableProjectId`. Its comment at :32 admits the copy, and the three messages have already drifted. mcp.ts:112 builds a caller by hand, and it is field for field what `SessionRpcTarget#caller` gives when `scopes` is omitted: the same principal, grant, platformOrigin and cause, and no `account` flag. mcp.ts:160 then dispatches through `contextStub(..., "mcp")`, the same function with the same retry policy that `IterateContextRpcTarget#invokeOnDurableObject` uses (area "itx"). consent-page.server.ts:92-107 already builds a SessionRpcTarget on the server, so "MCP is a session" follows a house pattern rather than a new one. It also makes the mcp.ts:14 header ("the same authorization and project root as a Cap'n Web project handle") literally true.

(a) What changes:

1. Refusal texts become the session's. Five assertions pin the current text: oauth.test.ts:114 is an exact match on 'FORBIDDEN: project "global": …', and oauth.test.ts:369, personal-access-tokens.test.ts:110, issuer-bootstrap.test.ts:133 and mcp-project-root.e2e.test.ts:180 all match "outside this token's grant".
2. There is a real regression hiding in (1). `describeReach` (edge.ts:46) ignores `projectIds` when `userId` is present. Every consent-narrowed OAuth grant (oauth.ts:451) and every PAT (oauth.ts:506) has that shape, so the new refusal would read "outside this session's reach — the projects of the orgs usr_x belongs to" for a project that IS in the person's org but was not selected. That is misleading for exactly the case issuer-bootstrap.test pins. The proposal needs a describeReach fix, which also fixes the same bad message on /api today.
3. Retry and failure log lines are named `itx.*` instead of `mcp.*`. I grepped apps/os, scripts, docs and .depot and found no consumer. perf's "mcp.call" is a latency probe name, not this area.
4. The answer now passes through `IterateContextRpcTarget.invoke`. A 508 loop-limit Response now throws its refusal instead of serializing as `{}`, which is a small fix. A live-handle answer becomes an InvokeHandle, which serializes as `{}` (toJSON is in the ignored-props list) instead of the raw `{"$itxHandleExpression":…}` marker. Plain JSON is unchanged.
5. Using `session.projects.list()` for the no-project default, as proposed, would switch that path to a fresh D1 read (`fresh=true` bypasses Kept) on every call. That is a needless latency cost, so the default should keep `controlPlane.reachableProjects(reach)`.
6. The global-namespace refusal now mentions `session.user` and `session.organizations`, which MCP clients do not hold. This is a cosmetic wart.

(b) It is simpler, modestly. There is one project-reach guard instead of two copies that already drift, and no hand-built caller or direct DO dispatch in mcp.ts. The cost is one object construction, which follows the consent-page precedent, plus threading `ctx` (api.ts gets shorter as a result). The main gain is maintenance: any check later added to `projects.get` (deleted-project refusal, onProjectAccess, admission rules) now covers MCP automatically, where today it would silently skip it. It is not a big win. projects.delete keeps its own intentional "no such project" spelling.

(c) No guarantee is dropped. The call hits the same `reachableProjectId` check with the same caller stamp and the same contextStub retry policy. MCP still refuses the operator bearer upstream (validateToken). The global and owner-subtree refusals still hold: the `global--users--u1` case fails in the codec either way.

(d) LOC re-measured: −18 source lines (mcp.ts −16, api.ts −2, edge.ts ±0), in line with the claim.

The risk is low to medium: it churns text in five test assertions, and the proposal as specified would have shipped a misleading refusal and an extra D1 read. Those two points are the amendments.

## Detect the sign-in challenge by its exact header, not with an RFC 9110 challenge-list parser

- Sweep index: 9; risk: low; payoff: 4/10
- LOC: About −55 net.
- project-host-sign-in.ts: 34 lines become 1 (−33).
- tests: the 21-line table shrinks to about 6, and the 7-line 'among others' row goes (about −22). (skeptic measured: - `apps/os/src/project-host-sign-in.ts`: 128 → 93 lines (+1/−36, net −35).
- `apps/os/src/project-host-sign-in.test.ts`: 273 → 243 lines (net −30).
- Total: −65 net.

Measured with wc -l on a scratch copy at `/private/tmp/claude-501/-Users-jonastemplestein--herdr-worktrees-iterate-first-party-agents/8c90908e-f48e-4f3f-adc0-08a3364e1b4c/scratchpad/signin-measure/{a,b}`. All 31 remaining rows passed under vitest.)

- Concepts: An HTTP auth-challenge grammar (3 regexes and a loop) becomes one exact header string.

### Evidence

- apps/os/src/project-host-sign-in.ts:83-116: `TOKEN`, `AUTH_PARAM`, `AUTH_SCHEME` and a loop over the challenge list, 34 lines in all.
- Every emitter sends exactly `Bearer realm="iterate"`:
  - packages/iterate/src/sdk/auth.ts:42 (`auth.require`)
  - the documented snippet at sdk/auth.ts:12-20 and sdk/index.ts:343
  - the edge's own challenge at worker.ts:190
- Tests: project-host-sign-in.test.ts:253-273 and :160-166.

### Current shape

Before the edge turns an app's 401 into a sign-in redirect, it parses the whole WWW-Authenticate grammar: several challenges, token68, quoted strings with escapes, and a case-insensitive scheme. It does this only to find a string that the SDK, the docs and the edge itself all emit verbatim.

### Proposed shape

`if (answer.headers.get('www-authenticate') !== 'Bearer realm="iterate"') return null;`

Delete `isIterateSignInChallenge` and the three regexes. Keep three table rows: the exact header, `Bearer realm="my-app"`, and a `Basic` challenge.

### What changes

A hand-written variant no longer gets the platform's sign-in redirect; its 401 passes through as the app's own. Examples of such variants:

- unquoted realm
- extra params, such as an error before the realm
- several challenges in one header
- an escaped realm

The SDK, the documented snippet and the edge's own challenge still match.

### Pinned by

- src/project-host-sign-in.test.ts:253-273 (6 `ours: true` variant rows flip)
- src/project-host-sign-in.test.ts:160-166

### Skeptic's amended proposal

In `apps/os/src/project-host-sign-in.ts`:

- Replace line 66 with `if (answer.headers.get("www-authenticate") !== 'Bearer realm="iterate"') return null;`.
- Delete lines 83-117: TOKEN, AUTH_PARAM, AUTH_SCHEME and the exported `isIterateSignInChallenge`.
- Optionally make the header comment at line 18 say "exactly" (no change in LOC).

In the test file:

- Drop the import.
- Drop the "the challenge among others" row at :160-166.
- Drop the whole parser table at :252-273.

No new rows are needed. The main table already covers the exact header (it is the default), `Basic realm="iterate"`, `Bearer realm="my-app"`, `Bearer error="invalid_token"` and the 403 status gate. At most, add one row showing a variant passes untouched, for example `bearer realm=iterate` → unchanged, to pin exactness (+7 lines).

Net −65 LOC, or −58 with that row.

### Skeptic's verdict

The claim holds against the real code at origin/main b3daf4846. PR #3446 does not touch these files.

(a) Semantics. Exact matching is strictly narrower than the parser, so it adds no false positives. It only drops the matches that the parser accepted and the exact string does not:

- scheme in another case (`bearer`, `BEARER`);
- unquoted realm (`realm=iterate`);
- params before or after the realm (`Bearer error="x", realm="iterate"`, `Bearer realm="iterate", scope="a"`);
- several challenges in one value, including several WWW-Authenticate headers that `Headers.get` joins;
- a backslash-escaped realm;
- extra whitespace around `=` or between the scheme and realm.

For those variants, a signed-out page load gets the app's raw 401 instead of a 302 to login, and a non-member's fetch gets 401 instead of 403.

Nobody emits a variant. Every emitter in the repo sends the exact string byte for byte:

- `packages/iterate/src/sdk/auth.ts:42`;
- the documented snippets at `sdk/auth.ts:20` and `sdk/index.ts:296`, and `apps/notes/README.md:37`;
- the edge's own challenge at `apps/os/src/worker.ts:190`;
- the e2e fixtures in `fetch-routes`, `ingress-project-host` and `path-ingress`.

The prd config repo (iterate/config) and the local iterategrations and waitrose checkouts have no WWW-Authenticate at all. Nothing between the app and the check touches the header: `withoutPlatformHeaders` strips only Service-Worker-Allowed and `__Host-itx-*` cookies. No PR #3058 reviewer asked for the parser; it was the author's own choice for robustness.

(b) The new shape is really simpler: one exact-string contract replaces an RFC 9110 challenge-list grammar (a TOKEN constant, two regexes, and a loop that handles escapes and token68). It is also easier to explain, because the docs already say "answer 401 with exactly this header".

(c) No guarantee is dropped. The rewrite turns a refusal into a redirect for convenience; it is not a security wall. Both answers still refuse. The member-loop guard (rule 5) and the status gate are untouched, and exact matching cannot hijack an app's own challenge more often than the parser did.

(d) I re-measured by applying the change to a scratch copy:

- `project-host-sign-in.ts`: 128 → 93 lines (−35);
- `project-host-sign-in.test.ts`: 273 → 243 lines (−30), dropping the import, the 7-line "among others" row and the 22-line parser table;
- total: −65 net, not −55.

All 31 remaining rows pass under vitest against the new shape. The e2e rows are unaffected because they all send the exact header.

Payoff is modest: this is an isolated pure function, not central machinery, but it is a clean removal of a whole concept.
