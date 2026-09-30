# Sweep candidates: test-infra-lint

Verified candidates from the 2026-09-29 codebase simplification sweep for this area. Each passed an adversarial skeptic check; where the skeptic amended the proposal, the amendment wins. Line numbers are as of origin/main on 2026-09-29 (about cfd8a1d36) and have drifted since: #3442, #3455 and #3460 touched some of these files. The index and the owner calls are in ../codebase-simplification-sweep.md.

## The Workers suite opens /api sessions one way, disposed with their test, instead of about 13 openers and four disposal schemes

- Sweep index: 84; risk: low; payoff: 5/10
- LOC: About −200 in the Workers files and −18 in the e2e client, measured with sed ranges:
- about 205 lines of openers
- plus about 50 lines of inline arrays and upgrades
- replaced by about 25 lines (skeptic measured: Gross blocks (sed ranges on origin/main b3daf4846), 250 lines in total:
- support.ts:230-279 (openSession, afterAll, adminSession): 50
- support.ts:323-330 (signedInMember's upgrade): 8
- oauth-support.ts:24-31: 8
- oauth-support.ts:76-100: 25
- personal-access-tokens.test.ts:526-563 (rpc and bareSocket): 38
- connect-your-account.test.ts:602-615: 14
- control-plane.test.ts:601-608: 8
- control-plane.test.ts:405-411: 7
- control-plane.test.ts:476-486: 11
- issuer-bootstrap.test.ts:580-606: 27
- project-lookups.test.ts:130-137: 8
- project-host-routing.test.ts:353-360: 8
- oauth.test.ts:691-703: 13
- e2e/support/client.ts:197-221: 25

On top of that, about 24 inline array and dispose lines, for about 274 gross.

Replacement is about 55–60 lines:

- openSession and adminSession: about 16
- oauth-support `rpc` kept (with a credential parameter): about 20
- hibernation carve-out: about 8
- e2e one-liners: about 6
- call-site one-liners: about 8

Removed imports save about 8 more.

Net is about −190 to −210: Workers about −175 to −190, e2e about −17. The candidate's −218 is slightly optimistic, because `rpc` stays and hibernation needs its own opener.)

- Concepts: About 13 openers and 4 disposal regimes become 1 opener and 1 rule.

### Evidence

Merges the parallel and heavy hunts.

The openers in apps/os/**workers-tests**/support.ts:

- :230-263 openSession: a module list, then an afterAll that sleeps 50 ms.
- :265-279 adminSession: takes a caller-owned array.
- :310-334 signedInMember: its own upgrade.

Local copies of the array-plus-onTestFinished-plus-adminSession pattern:

- oauth-support.ts:25 actingAs
- `operator()` at control-plane.test.ts:602, issuer-bootstrap.test.ts:581 and project-lookups.test.ts:131
- instance-lends.test.ts:226 operatorGlobal
- inline in personal-access-tokens.test.ts:413, project-create-holds-no-account.test.ts:19, secret-oauth-client-secret-placeholder.test.ts:140 and secret-sockets-over-lends.test.ts:54 and :280

Arrays that are never disposed:

- connect-your-account.test.ts:178 (disposed only at :212, so a failed row leaks)
- secret-exchange-code.test.ts:80

Hand-rolled upgrades:

- oauth-support.ts:78 `rpc`, re-copied at personal-access-tokens.test.ts:530
- `bareSocket` ×2
- issuer-bootstrap `connect`
- project-host-routing `api`
- control-plane.test.ts:405-411 and :476-486
- oauth.test.ts:691-703

Also: oauth-support.ts:72 still sets the admin bearer on /login, and control-plane.test.ts:379-387 proves that bearer signs nobody in.

In the e2e client, e2e/support/client.ts:198-221 hand-spells what `session(headers)` at :155 already does.

### Current shape

Every file that needs a capnweb session writes its own upgrade → accept → newWebSocketRpcSession sequence and picks a disposal: file-level afterAll, caller array, end of body, or `using`. The copies have drifted on the 101 check, `closed`, and credential handling.

### Proposed shape

```ts
export async function openSession(headers: Record<string, string> = {}): Promise<any> {
  const response = await exports.default.fetch(`${ORIGIN}/api`, {
    headers: { ...headers, Upgrade: "websocket" },
  });
  expect(response, response.status === 101 ? "" : await response.text()).toMatchObject({
    status: 101,
  });
  const socket = response.webSocket!;
  socket.accept();
  const closed = new Promise<void>((r) =>
    socket.addEventListener("close", () => r(), { once: true }),
  );
  const transport = newWebSocketRpcSession<IterateRpcTarget>(socket as unknown as WebSocket);
  onTestFinished(() => transport[Symbol.dispose]());
  return Object.assign(transport, { closed });
}
export const adminSession = async (email?: string) =>
  (await openSession()).authenticate({ ...adminCredentials(), ...(email && { as: { email } }) });
```

- signedInMember and oauth-support `rpc` become one-liners on openSession.
- Every local copy goes, along with the dead /login bearer.
- In e2e: `publicSession` and `cookieSession` become `session({…}).authenticate(...)`.

### What changes

- Sessions are disposed at their own test's end instead of at file end after 50 ms. No session crosses tests, and onTestFinished runs in stack order, so a row's revoke-then-dispose still works.
- A failed row's sessions are always disposed now.
- Openers that skipped the 101 check fail with the response text.
- Rows whose subject is the raw socket keep their own upgrades.

### Pinned by

No test pins the lifetime itself. Every session-using Workers row exercises it, notably:

- control-plane.test.ts
- oauth.test.ts
- oauth-recheck-*.test.ts (needs `closed` and `boundAt`)
- personal-access-tokens.test.ts
- issuer-bootstrap.test.ts
- connect-your-account.test.ts
- secret-*.test.ts
- apps/agents/**workers-tests**/agent-revive.test.ts

### Skeptic's amended proposal

A session lives for its test. There is one opener, plus one socket-owning variant for the rows that watch the close, plus one named exception.

```ts
// support.ts: replaces :230-279 (the module list, the afterAll and its 50 ms sleep, the caller-array adminSession)
/** A capnweb session over `origin`'s /api with `headers` on the upgrade (bare by default: it authenticates
 *  in-band), disposed when the running test finishes. `any`: the lending entry point (`.provide(key, new Echo(i))`). */
export async function openSession(
  headers: Record<string, string> = {},
  origin = ORIGIN,
): Promise<any> {
  const response = await exports.default.fetch(`${origin}/api`, {
    headers: { ...headers, Upgrade: "websocket" },
  });
  expect(response, response.status === 101 ? "" : await response.text()).toMatchObject({
    status: 101,
  });
  response.webSocket!.accept();
  const transport = newWebSocketRpcSession<IterateRpcTarget>(
    response.webSocket! as unknown as WebSocket,
  );
  onTestFinished(() => transport[Symbol.dispose]());
  return transport;
}
export const adminSession = async (email?: string) =>
  (await openSession()).authenticate({ ...adminCredentials(), ...(email && { as: { email } }) });
```

1. `signedInMember` (:323-330) becomes `(await openSession({ Origin: ORIGIN, Cookie: cookie })).authenticate({ type: "from-server-cookie" })`.
2. Delete `actingAs` and every `operator()`/`operatorGlobal`/inline array. Callers call `adminSession(email)`:
   - oauth-support:24
   - control-plane:602
   - issuer-bootstrap:581
   - project-lookups:131
   - instance-lends:226
   - personal-access-tokens:414
   - project-create-holds:19
   - secret-oauth-placeholder:140
   - secret-sockets:54/:280
   - secret-exchange:80/:95
   - connect-your-account:178/:212
3. These become `openSession(headers[, origin])`:
   - both `bareSocket`s
   - project-host-routing `api()` (its `using` callers stay; a second dispose is a no-op)
   - control-plane:405 and :476
   - issuer-bootstrap `connect` (`(await openSession(headers)).authenticate({type:"from-server-cookie"})`)
   - oauth.test:691 (passes `origin`)
4. Keep oauth-support `rpc` as the ONE opener that owns its socket (for `closed` and `boundAt`). A capnweb stub cannot carry `closed`: its proxy `set` throws. Give it PAT's `credential = { type: "bearer", token }` parameter and delete personal-access-tokens.test.ts:529-549.
5. hibernation-at-scale.test.ts keeps an explicitly file-lifetime fleet. Its rows share one fleet by design (:43). Give it a local 5-line raw upgrade plus `afterAll(() => fleetSession?.[Symbol.dispose]())`, so the one cross-row session is named where it lives.
6. Drop the dead admin bearer on /login: oauth-support.ts:72 and the `adminSecret` constant at :22. control-plane.test.ts:379-387 proves that bearer signs nobody in.
7. e2e/support/client.ts:
   - `publicSession = (token) => session({ Authorization: `Bearer ${token}` }).authenticate({ type: "bearer", token })`
   - `cookieSession = (cookie) => session({ Cookie: cookie, Origin: new URL(workerUrl("/")).origin }).authenticate({ type: "from-server-cookie" })`
   - Both gain `explainSocketFailure`.

Rows whose subject is the raw socket keep their own upgrades: ws-fetch-live-101, loop-guard:394, rpc-stub-pager-attach:262, the facets shop at :1268, and oauth-recheck-platform-failure (which goes through `rpcResponse`, not `exports.default`).

Semantics that change:

- About 170 call sites in 38 files are disposed at test end instead of file end after the 50 ms drain. A lend's rule un-set now lands during the next row, and every other row uses a fresh ctx.
- A failed row's admin sessions are now disposed.
- Openers that skipped the 101 check now fail with the response body.

Pinned by:

- hibernation-at-scale rows 2 and 3 (they would catch a wrong carve-out)
- the oauth-recheck-* files (`closed` and `boundAt`)
- the full Workers suite, plus `--sequence.seed=7` for order independence.

Risk: medium-low, because the lifetime shift is broad.

Concepts: 4 disposal regimes and about 13 openers become 1 rule, `openSession` + `adminSession`, 1 socket-owning `rpc`, and 1 named file-lifetime exception.

### Skeptic's verdict

The duplication is real and has drifted. The fix is right in direction, but the sketch as written would break the suite in two places.

What holds:

- `adminSession(sessions, email)` in support.ts:265 makes each caller own an array. That produced about nine copies of the same 4–8 line wrapper: oauth-support `actingAs` (:24), `operator()` at control-plane.test.ts:602, issuer-bootstrap.test.ts:581 and project-lookups.test.ts:131, instance-lends.test.ts:226, and inline in personal-access-tokens.test.ts:414, project-create-holds-no-account.test.ts:19, secret-oauth-client-secret-placeholder.test.ts:140 and secret-sockets-over-lends.test.ts:54/:280.
- The hand-rolled upgrades have drifted: some check for a 101 and some just do `webSocket!` on whatever came back. They are `bareSocket` ×2, `api()`, issuer-bootstrap `connect`, control-plane :405/:476, oauth.test :691, and `rpc` twice (oauth-support :76, personal-access-tokens.test.ts :529).
- The file-end `afterAll` in support.ts:250 sleeps 50 ms to dodge `EnvironmentTeardownError`. That guard is redundant: vitest.config.ts:48-53 `onUnhandledError` already swallows that error.
- connect-your-account.test.ts:178 does leak on a failed row, because its dispose only runs at :212.
- Workers rows run one after another (concurrency is e2e-only, vitest.config.ts:363-371). So the global `onTestFinished` binds to the right row.
- In vitest 4.1.11 the `onTestFinished` hooks run in stack order (@vitest/runner chunk-artifact.js:2985 passes "stack"). So cleanups registered after an open still run before the dispose: secret-sockets-over-lends :65/:285, secret-exchange-code :92, project-create-holds :51.
- The e2e half is a genuine near no-op. `publicSession` and `cookieSession` (client.ts:198-221) build the same URL as `session(headers)`; `workerUrl` and `wsApi` are both `baseUrl()`. The only change is that they gain `explainSocketFailure`.

What is wrong in the candidate:

1. `Object.assign(transport, { closed })` throws. capnweb's stub proxy `set` trap throws "Can't assign properties on RPC stubs." (@iterate-com/capnweb 0.12.3 dist/index.js:205). Even if it didn't throw, reading `transport.closed` would return a remote pipelined `RpcPromise`, not the local promise. So `closed` and `boundAt` cannot ride the returned stub. The oauth-recheck rows need them, so oauth-support `rpc` has to stay as the one opener that owns its socket.
2. "No session crosses tests" is false. hibernation-at-scale.test.ts:43 says "The rows run in file order and share one fleet". Its `fleetCaller` (:132-156) caches one session carrying 200 lends across its three rows. Disposing at test end would kill the fleet after row 1 and break rows 2 and 3. That file needs an explicit file-lifetime opener.
3. secret-exchange-code.test.ts:80 is not a leak: it is disposed in `onTestFinished` at :95.
4. oauth.test.ts:691 upgrades on a varying `origin` (a project host), not `ORIGIN`. `openSession` needs an origin parameter, or that row stays as it is.
5. The risk is not "low". The lifetime moves from file end to test end for about 170 call sites in 38 files (openSession 61, signedInSession 14, signedInMember 14, projectWithMember 83). A lend's teardown (the pager closes and its rule is un-set) now runs during the next row instead of at file end.

I checked for other rows that depend on a session living past its test:

- The suite has no `beforeAll` or `beforeEach`.
- The only module-level cache is hibernation's `fleet`.
- The only other shared contexts are context-runs' and agent-revive's fixed ctx, and neither holds a session or lend across rows.

It does not drop any guarantee: sessions are still always disposed, and now sooner.

It is not a nit or a lateral move. About 4 disposal regimes and 13 openers become one rule, one opener, one socket-owning opener and one named exception.

## iterate/no-implied-eval re-implements oxlint's built-in no-implied-eval

- Sweep index: 87; risk: low; payoff: 2/10
- LOC: −36 lines. (skeptic measured: lint/oxlint-plugin-iterate.ts lines 1199-1234 are 36 lines (sed | wc -l), so the file goes from 1323 to 1287 lines. The .oxlintrc.json:136 line is renamed, not removed, so net −36 LOC. `getCalleeName` (line 31) must stay because spec-restricted-syntax at line 1290 still uses it.)
- Concepts: One custom rule that duplicates a built-in becomes the built-in.

### Evidence

- lint/oxlint-plugin-iterate.ts:1199-1234 is a 36-line custom rule that matches callee names by string.
- .oxlintrc.json:136 enables it.
- oxlint 1.85.0, the pinned version, ships `no-implied-eval` (configuration_schema.json:4883).
- A probe with the repo's own binary showed the built-in flags `setTimeout('…')`, ``setInterval(`…`)`` and `globalThis.setTimeout('…')`.
- The custom rule was added in #1577. No test covers it.

### Current shape

The custom rule misses `globalThis.setTimeout` and flags any object's method that happens to be called setTimeout.

### Proposed shape

Rename the entry in .oxlintrc.json to `"no-implied-eval": "error"` and delete the custom rule block. Also delete `getCalleeName` if nothing else uses it.

### What changes

- Global receivers are now reported.
- The false positive on unrelated `setTimeout` methods goes.
- The message text changes.

### Pinned by

Nothing except `pnpm lint` over the tree.

### Skeptic's amended proposal

In .oxlintrc.json:136, replace `"iterate/no-implied-eval": "error"` with `"no-implied-eval": "error"`. Delete the `"no-implied-eval"` block at lint/oxlint-plugin-iterate.ts:1199-1234. Keep `getCalleeName`, because spec-restricted-syntax (line 1290) uses it.

Correct semantic delta:

- The built-in adds coverage for string concatenation (`setTimeout('x' + s)`).
- The false positive on unrelated `obj.setTimeout('…')` goes.
- `execScript` coverage goes (IE-only).
- Under the repo's current env (builtin + node), the built-in does NOT flag `window.setTimeout('…')`, `self.setTimeout('…')` or computed `window['setTimeout']`. The custom rule does. Optionally recover this by adding `"browser": true` to env, but prove first that doing so changes no other rule's output over the tree.
- `globalThis.setTimeout('…')` is flagged by both, so it is not a gain.
- Report position moves from the argument to the call, and the message text changes.

Verified: the built-in rule with the repo's env and ignorePatterns reports 0 problems over the tree, so `pnpm lint` stays green. Nothing else pins the rule.

Concepts: one bespoke rule plus its config entry becomes one built-in config entry. LOC: −36.

### Skeptic's verdict

The proposal holds, but the payoff is small and the candidate's evidence has the semantics partly wrong.

Checked on origin/main (b3daf4846) with the repo's own oxlint 1.85.0. PR #3446 does not touch lint/ or .oxlintrc.json.

History: the custom rule came in with the ESLint-to-oxlint move in #1053 (9fb7d55cb), not #1577. #1577 only moved the plugin into lint/.

(a) Semantics, from probe files run under the repo's real env (builtin + node):

- **Wrong claim in the candidate:** the custom rule does NOT miss `globalThis.setTimeout('…')`. `getCalleeName` returns the member's property name, so the probe flagged it at 6:23.
- **The built-in newly flags string concatenation** such as `setTimeout('x' + code)`. The custom rule only looks at literal and template first arguments.
- **The built-in stops flagging `window.setTimeout('…')`, `self.setTimeout('…')` and `window['setTimeout']('…')`** under the repo's env. The custom rule catches all of these. The built-in only catches them after adding `"browser": true` to env, which I did not test across the whole tree. This is a real coverage loss for the TSX client apps.
- **`execScript` is no longer flagged.** It is IE-only and dead.
- **The false positive on unrelated `obj.setTimeout('…')` goes.**
- **Report location and message change.** The built-in reports at the call, not at the first argument.

None of this matters today. Both rules find zero hits across apps, packages, lint, scripts and specs; I ran the built-in over the tree with the repo's env and ignorePatterns, and it exited 0. No test pins either rule: there is no `lint/*.test.ts` for no-implied-eval, and the scope-liveness and library-rule tests don't reference it.

(b) Simpler: yes, a little. One bespoke JS-plugin visitor, which runs on every CallExpression in the slower JS plugin runtime, becomes one native built-in rule with the same config line count. It is real "a re-implementation of what the tool already does", not a lateral move.

(c) Guarantee: no real guarantee is lost. The rule is a hygiene lint with zero hits. The only weakening is `window.` and `self.` receivers in browser code.

(d) The LOC is −36, as claimed.

Payoff is low because this is 36 plain, readable lines in a peripheral lint plugin, not heavy or convoluted product code. It is worth doing only as a one-line tail item in a lint-cleanup PR.

## The e2e deployment target travels as one value through one transport, not five named values, two transports and a zod re-validation

- Sweep index: 88; risk: low; payoff: 4/10
- LOC: About −120:
- vitest side: about −63
- Playwright side: about −60
- spec call sites: renames only (skeptic measured: Sketched in a scratch copy and measured with `git diff --numstat`: +83/−162 over 16 files, net −79 (about −77 after prettier). The candidate claimed about −120.

| File                          | Added                      | Removed                    |
| ----------------------------- | -------------------------- | -------------------------- |
| client.ts                     | 16                         | 33                         |
| global-setup.ts               | 12                         | 31                         |
| project-host.ts               | 3                          | 10                         |
| setup.ts                      | 0                          | 5                          |
| deployed-target.ts            | 11                         | 5                          |
| specs/setup.ts                | 15                         | 27                         |
| auth-config.ts (deleted)      | 0                          | 33                         |
| e2e-target.ts (new)           | 8                          | 0                          |
| 8 spec and fixture call sites | 2 each (4 in issuer-pages) | 2 each (4 in issuer-pages) | )   |

- Concepts: About 5 keys × 2 transports, plus an env schema and a double JSON encoding, become one E2eTarget value and one reader.

### Evidence

The vitest path:

- apps/os/e2e/support/global-setup.ts:24-51 declares 5 ProvidedContext fields.
- global-setup.ts:69-89 provides each field separately.
- setup.ts:15-19 copies each one into process.env.
- client.ts:15-40 and 56-61, plus project-host.ts:49-57, read them back through five hand-written 'X unset' getters.
- deployed-target.ts:46 JSON-stringifies ingressRouting, and both sides JSON.parse it again.

The Playwright path:

- specs/setup.ts:30-49 maps the same deployedTarget() into four env names.
- specs/setup.ts:20-26 zod-validates them through specs/test-support/auth-config.ts:4-20, whose refine JSON.parses its own JSON.
- Every fixture call re-parses process.env (auth-config.ts:24-33). The callers are forged-session.ts, issuer.ts, operator.ts and 5 specs.

### Current shape

deployedTarget() returns one typed object. Each suite breaks it into 4–5 env vars or provide keys, each with its own guard or schema, and then reassembles it at every reader.

### Proposed shape

```ts
export type E2eTarget = {
  workerBaseUrl: string;
  adminBearer: string;
  loginPassword: string;
  ingressRouting: IngressRouting;
  mcpBaseUrl: string;
};
export const e2eTarget = (): E2eTarget => {
  const json = process.env.E2E_TARGET;
  if (!json) throw new Error("E2E_TARGET unset — the suite's setup did not run");
  return JSON.parse(json);
};
```

- global-setup provides `target`, and setup.ts sets E2E_TARGET.
- specs/setup.ts sets E2E_TARGET.
- Readers call `e2eTarget().x`.
- Delete auth-config.ts, the five getters and the five-field ProvidedContext.
- WORKER_BASE_URL stays as the input that picks the deployment.

### What changes

- One error message replaces five.
- Specs stop refusing, at setup, a deployment with no login password. Such a run now fails at its first sign-in, as the vitest suite already does.
- The zod checks on values setup itself produced go.
- apps/agents/scripts/client.ts reads its own CLI inputs and is unaffected.

### Pinned by

Nothing pins the plumbing. It is exercised by every e2e, perf and bench row, and by every spec through forged-session.ts and operator.ts.

### Skeptic's amended proposal

One value, `E2eTarget`, flows from `deployedTarget()` to every reader.

**1. apps/os/e2e/support/deployed-target.ts**

```ts
export type E2eTarget = {
  workerBaseUrl: string;
  adminBearer: string;
  /** empty where the deployment sets no login.password (prd) */ loginPassword: string;
  ingressRouting: IngressRouting;
  mcpBaseUrl: string;
};
export function deployedTarget(workerBaseUrl: string): E2eTarget; // returns workerBaseUrl too; ingressRouting: env?.ingressRouting || null (an object, no JSON.stringify)
```

**2. global-setup.ts**

The ProvidedContext's five fields become `target: E2eTarget`. The deployed branch is `project.provide("target", deployedTarget(url))`. The local branch provides one object literal with E2E_ADMIN_BEARER, E2E_LOGIN_PASSWORD, E2E_INGRESS_ROUTING (not stringified) and `<url>/mcp`.

**3. setup.ts**

Delete the five `process.env.X = inject(...)` lines.

**4. client.ts**

Replace the baseUrl, adminBearer and mcpUrl getters with:

```ts
export const e2eTarget = (): E2eTarget => {
  const t = inject("target");
  if (!t) throw new Error("no e2e target — the e2e globalSetup did not run");
  return t;
};
export const loginPassword = () => {
  const { loginPassword } = e2eTarget();
  if (!loginPassword) throw new Error("the deployment under test sets no login.password (prd)");
  return loginPassword;
};
```

Readers use `e2eTarget().workerBaseUrl`, `.adminBearer` and `.mcpBaseUrl`.

**5. project-host.ts**

```ts
export const ingressRouting = (): IngressRouting => e2eTarget().ingressRouting;
```

**6. specs/setup.ts**

- `osTarget(): E2eTarget` returns the local dev literal (with `ingressRouting` as an object), or `deployedTarget(workerBaseUrl)`.
- Keep the doppler-hint try/catch.
- Keep the empty-password refusal as a 3-line guard.
- Then set `process.env.E2E_TARGET = JSON.stringify(target)`.
- Drop zod.

**7. Delete specs/test-support/auth-config.ts**

Add specs/test-support/e2e-target.ts:

```ts
export function e2eTarget(): E2eTarget {
  const json = process.env.E2E_TARGET;
  if (!json) throw new Error("E2E_TARGET unset — specs/setup.ts did not run");
  return JSON.parse(json);
}
```

Rename `readOsPlaywrightAuthConfig()` to `e2eTarget()` in forged-session.ts, issuer.ts, operator.ts and 5 specs. Update the comments in auth.spec.ts:3/105 and mini-app.spec.ts:60 that name LOGIN_PASSWORD and PROJECT_INGRESS_ROUTING.

**Optional, same pattern:** client.ts `runId` can read `inject("runId")` and drop the E2E_RUN_ID relay in setup.ts.

**Semantics change:**

- One error message replaces five.
- The zod checks on setup's own output go.
- Vitest worker process.env no longer carries the five names. No child process relies on them: each one sets its bearer explicitly.
- With the guard kept, nothing else changes.

**Concepts:** 9 env names or provide keys, plus a zod schema and double JSON, become 1 type, 1 provide key and 1 env var.

**Risk:** low. Typecheck catches every reader.

**Pinned by:** no dedicated test. Every e2e, perf and bench row and every spec (through forged-session and operator) exercises it. Verify with `pnpm e2e` locally plus a `pnpm spec` smoke run.

### Skeptic's verdict

The core claim holds. Checked on main b3daf4846, which already includes #3446. #3446 touches client.ts but not this plumbing.

(a) What actually changes:

1. The five "X unset — globalSetup did not run" errors become one.
2. The zod schema goes. It only checked values setup had just built itself: `mcpBaseUrl` comes from `new URL(...)`, and `ingressRouting` comes from `JSON.stringify`. It could never fail except on the empty prd password.
3. Vitest worker processes stop carrying WORKER_BASE_URL, APP_CONFIG_SECRETS__ADMIN_BEARER, LOGIN_PASSWORD, PROJECT_INGRESS_ROUTING and MCP_BASE_URL in process.env.

I checked every child process that inherits `...process.env`:

- iterate-cli.e2e already blanks the bearer.
- provide, tunnel and serve-localhost-example pass `adminCredentials().secret` explicitly.
- The CLI does not read WORKER_BASE_URL.
- No test stubs these env vars.
- No script outside vitest imports e2e/support.
- apps/agents/scripts has its own client.
- The unit project imports neither client.ts nor project-host.ts.

The one real behaviour change the candidate names: specs run against prd, which sets no password, would stop refusing at setup and fail at every sign-in instead. Specs only run against local and previews (`pnpm preview specs`), and a 3-line guard in specs/setup.ts keeps even that exact.

(b) It really is simpler.

- Before: 5 ProvidedContext keys, 5 env relays, 5 getters, 4 more env names for Playwright, a zod schema, and routing JSON-encoded in deployedTarget then parsed again on both sides.
- After: one E2eTarget type, which deployedTarget already nearly returns, one provide key, one env var for Playwright, and one reader per suite.

(c) No guarantee is lost. The prd login password check survives on both sides: in client.ts `loginPassword()` and as the specs/setup.ts guard.

(d) LOC is overstated. I sketched the change in a scratch copy and measured with `git diff --numstat`: +83/−162 over 16 files, net **−79**, not −120. After prettier wraps the guard it is about −77.

- Vitest side: −42 (client −17, global-setup −19, project-host −7, setup −5, deployed-target +6).
- Playwright side: −37 (setup −12, auth-config.ts −33, a new 8-line reader, 9 call sites renamed only).

Amendment on the vitest side: don't relay through E2E_TARGET at all. Read `inject("target")` directly in client.ts, as apps/agents/e2e/support.ts already does with `inject("publishedPackageCommit")`. That drops both the env relay and all JSON on that side. Playwright keeps one env var, because its documented transport is globalSetup's process.env being inherited by workers.

Test infrastructure, not central code, so payoff is moderate.

## Inline the presence e2e fixture like every other fixture, instead of a four-file processor triplet with its own unit test

- Sweep index: 89; risk: low; payoff: 3/10
- LOC: About −100 across 4 files. (skeptic measured: - `presence/` loses 119 lines: contract.ts 38, processor.ts 40, durable-object.ts 10, processor.test.ts 31.
- `sources.ts` gains 15 net (+30/−15): the loader and PRESENCE_SOURCE go, and a 29-line inline entry comes in. Drafted at scratchpad/presence-measure/sources.new.ts.
- `knip.ts` loses 2.
- README.md is ±0, since 2 lines are rewritten.
- Net is about −106 LOC across 7 files. Concepts go from 4 (triplet, disk loader, fixture unit test, knip exception) to 1 (an inline SOURCES entry like its 11 siblings).)
- Concepts: A 3-file triplet, a disk loader and a fixture unit test become one inline entry.

### Evidence

- apps/os/e2e/support/presence/{contract.ts 38, processor.ts 40, durable-object.ts 10, processor.test.ts 31}.
- sources.ts:6-19 loads them with readFileSync.
- The sibling fixtures chunky (:91-115) and user-tally (:118-140) are about 20 lines each, inline.
- It has one user: live-state-chains-client-side.e2e.test.ts:108.
- presence/processor.test.ts unit-tests the fixture's own reduce.
- knip.ts:60 keeps the directory alive. packages/iterate/README.md:131 cites the fixture's test as its reduceProcessor example.

### Current shape

This test fixture follows the product processor triplet convention and has its own unit test. It is the only fixture shaped this way.

### Proposed shape

One inline `presence` entry in SOURCES, with two TypeScript modules: `worker.ts` for the DO shell, and `processor.ts` for the contract plus processor, in about 25 lines.

- Delete presence/ and the file loader.
- Drop the knip entry.
- Point the README at src/account/processor.test.ts.

### What changes

- The e2e row loads the same classes, className and consumes, still as multi-module TypeScript.
- Lost: the fixture's own reduce unit test (the e2e row asserts the same ticks and pokes), and tsc checking of the fixture, which becomes a string like its siblings.

### Pinned by

- e2e/live-state-chains-client-side.e2e.test.ts:97
- **workers-tests**/named-facets.test.ts and publication.test.ts pin multi-module TypeScript loading

### Skeptic's amended proposal

Make `presence` one inline single-module `worker.js` entry in SOURCES, exactly like `chunky`. Do not use two TypeScript modules: other rows already cover TypeScript stripping and relative imports on a deployed worker (npm-packages, website-publication and mcp-project-root e2e) and as unit tests (module-resolution.test.ts).

```ts
  // Live state combining REDUCED state (ticks, from durable 'tick') with a RUNTIME field
  // (lastPokeMs, bumped by an ephemeral 'poke' in processEvent, never reduced, gone on eviction).
  presence: {
    "package.json": '{"main":"worker.js"}',
    "worker.js": `import { StreamProcessorDurableObject } from "iterate/sdk";
import { StreamProcessor, defineProcessorContract } from "iterate/stream/processor";
import { z } from "zod";
const contract = defineProcessorContract({
  slug: "presence", version: "1.0.0",
  description: "Reduced tick count beside a runtime lastPokeMs the reduce never sees.",
  stateSchema: z.object({ ticks: z.number().default(0) }),
  consumes: ["tick", "poke"], emits: [],
});
class PresenceProcessor extends StreamProcessor {
  contract = contract;
  #lastPokeMs = 0;
  reduce({ event, state }) { if (event.type === "tick") return { ...state, ticks: state.ticks + 1 }; }
  processEvent({ event }) { if (event?.type === "poke") this.#lastPokeMs = Date.now(); }
  projectLiveState(state) { return { ticks: state.ticks, lastPokeMs: this.#lastPokeMs }; }
}
export class PresenceDurableObject extends StreamProcessorDurableObject {
  processor = new PresenceProcessor();
}`,
  },
```

Then:

- Delete `apps/os/e2e/support/presence/`, all 4 files.
- Delete the readFileSync/fileURLToPath imports and PRESENCE_SOURCE from `sources.ts:6-19`.
- Drop the entry at `knip.ts:59-60`.
- In `packages/iterate/README.md:131-132`, replace the fixture citation with a self-contained line such as `reduceProcessor(new MyProcessor(), [{ type: "tick" }])`, or cite `apps/os/src/account/processor.test.ts`.

These stay as they are:

- the e2e test at `live-state-chains-client-side.e2e.test.ts:108-111`, with the same className and consumes;
- the `enableFixtureProcessor` doc comment;
- the `sdk/index.ts:51-55` example.

Tests pinning the current behaviour:

- `e2e/live-state-chains-client-side.e2e.test.ts:97-148`, the only consumer;
- `e2e/support/presence/processor.test.ts`, which is deleted;
- `src/context/module-resolution.test.ts:42-54` and `e2e/npm-packages.e2e.test.ts`, which keep the loader paths the fixture incidentally touched.

Risk: low.

### Skeptic's verdict

The claim holds against origin/main at b3daf4846. PR #3446 is already merged and touches none of these files.

**Why the shape exists and why it expired.** `presence` is the only one of 12 SOURCES fixtures that is loaded from disk. `sources.ts:6-19` reads `presence/{durable-object,processor,contract}.ts` with readFileSync. It has its own unit test and needs a knip entry exception (`knip.ts:59-60`). The shape is left over from when it lived in `apps/os/src/client/presence` as product-ish code. #3061 made it a file-backed source, and #3212 (2026-09-26, STR-10) moved it into `e2e/support`, but it kept the product processor triplet. No rule in `rules/` or `docs/` asks for that shape for a test fixture. Its only consumer is `e2e/live-state-chains-client-side.e2e.test.ts:108-148`.

**(a) Everything that changes:**

1. **Unit rows deleted.** The three `reduceProcessor` rows in `presence/processor.test.ts` go. They test a fixture's reduce. The e2e row already pins the same facts: tick goes 0 to 1 to 2, a poke leaves ticks at 1, and the final state equals `{ticks: 2, lastPokeMs}`.
2. **No more tsc check of the fixture.** It becomes a string like its siblings.
3. **Deployed-worker coverage of three loader paths moves elsewhere.** The fixture no longer exercises TypeScript stripping, a `.ts`-extension relative import, or inline `type`-import elision on the deployed worker. Other tests cover these:
   - `src/context/module-resolution.test.ts:42-54` covers `./lib/b.ts`, type-only elision and relative imports, as a unit test.
   - `e2e/npm-packages.e2e.test.ts` covers deployed TypeScript with a `type` alias.
   - `mcp-project-root` and `website-publication` e2e cover deployed relative imports.
4. **The contract loses its `events` catalog.** With no catalog, `payloadSchemaFor` returns undefined (`processor.ts:660,1287`), so tick and poke fold without validation. The e2e row appends only payload-less events, and payload-less events validate as `{}` anyway, so there is no behaviour change. The `ephemeral: true` flag in the catalog is type-level only. What makes the poke ephemeral is `consumes` on the enable call and on the contract, and both are kept.
5. **The README needs a new example.** `packages/iterate/README.md:131-132` cites the fixture test. Replace it with a self-contained snippet, or point it at `apps/os/src/account/processor.test.ts:310`, which does use `reduceProcessor`.

   `PresenceDurableObject` and `PresenceProcessor` in the `sdk/index.ts:51-55` comment stay accurate, because the inline source keeps both class names.

**(b) Simpler.** The candidate's "two TS modules" is an unneeded half-step. Since coverage of the loader paths lives elsewhere, the fixture should be one `worker.js` exactly like chunky and user-tally. That removes the last special case.

**(c) Guarantees.** No real guarantee is dropped. It is a test fixture with one e2e consumer.

**(d) LOC re-measured.** I drafted the inline entry in the scratchpad:

| File         | Change                       |
| ------------ | ---------------------------- |
| `sources.ts` | 352 to 367 (+30/−15, so +15) |
| `presence/`  | −119 across 4 files          |
| `knip.ts`    | −2                           |
| README       | ±0                           |

Net is about **−106 LOC**, which matches the candidate's "about −100".

**Verdict.** Payoff is modest because the code is peripheral test infrastructure. It is still a real "one of these is not like the others", not a nit. It removes:

- a disk loader;
- a fixture unit test;
- a knip exception;
- an SDK README that points at a test fixture as the canonical example.

## A row's tag is its registry: drop the hand-kept slow-row file list and the full-title warn-exemption registry

- Sweep index: 90; risk: low; payoff: 4/10
- LOC: About −55:
- budgets.ts: −37
- finalizer: about −12, finalizer tests about −20
- e2e-policy.test.ts: −5
- slow-rows.test.ts: −10
- additions: about +27 (skeptic measured: About −45 to −50 net across about 14 files.

- budgets.ts −37 (lines 79-89 and 95-121 deleted)
- scripts/ci/test-telemetry-finalizer.ts about −14
- scripts/ci/test-telemetry-finalizer.test.ts about −14
- scripts/ci/e2e-policy.test.ts −6
- apps/os/scripts/slow-rows.test.ts about −7
- apps/os/scripts/slow-rows.ts about +9
- apps/os/scripts/preview.ts +1
- dashboard.ts −1
- apps/os/vitest.config.ts about +12
- tags on about 11 rows about +8
- docs about 0

Base files by wc -l: budgets.ts 142, e2e-policy.test.ts 129, slow-rows.test.ts 82, slow-rows.ts 50, finalizer 144, finalizer test 265.)

- Concepts: 4 mechanisms (2 registries, an exactness test, a staleness detector) become 1: tags on rows.

### Evidence

Slow-row list:

- packages/shared/src/test-support/e2e-policy/budgets.ts:79-88 `SLOW_ROW_PATHS` lists the files with a `slow`-tagged row.
- scripts/ci/e2e-policy.test.ts:72-76 exists only to force that list to equal a regex scan.
- apps/os/scripts/slow-rows.test.ts:43-52 re-checks each entry.

Warn-exemption registry:

- budgets.ts:96-120 `UNIT_ROW_WARN_EXEMPTIONS` keys 11 rows by full title; one title is about 300 characters.
- test-telemetry-finalizer.ts:105-144 adds a stale-entry detector for it.
- dashboard.ts:528 looks titles up in it, while :530 of the same function already reads `row.tags.includes('slow')`.

### Current shape

Whether a row is slow, or allowed to wait past 10 s, is written twice. It appears once on the row and once in a registry in another package, with tests and detectors to keep the two in step.

### Proposed shape

- slow-rows.ts derives the slow files from the checkout, using the regex e2e-policy.test.ts already has. preview.ts passes them into `chooseSlowRows`.
- Unit rows that wait on purpose get `{ tags: ['waits'] }`, with the reason as a comment on the row, and `waits` is defined next to `slow`.
- Delete both registries, the exactness row and the stale-entry warning.

### What changes

- A PR editing a slow-row file still runs the slow rows, now computed from the PR's checkout.
- Renaming an exempt row keeps its exemption instead of warning again.
- The stale-entry warning goes. A cheap replacement would be 'tagged waits but ran under 10 s'.
- Only warnings and the dashboard Cost labels are affected, never a verdict.

### Pinned by

- scripts/ci/e2e-policy.test.ts:72
- apps/os/scripts/slow-rows.test.ts:5-52
- scripts/ci/test-telemetry-finalizer.test.ts:223-260
- dashboard.test.ts Cost rows

### Skeptic's amended proposal

A row's tag is its registry.

1. Unit and Workers rows that wait a real deadline get `{ tags: ["waits"] }`. The reason goes in a comment on the row; most already have one, e.g. the oauth-recheck file headers.
   - Tag the 7 rows that still exist from the registry.
   - Also tag the two rows the registry misses today: oauth-recheck-platform-failure.test.ts:17 (renamed in #3252) and facet-timeout-restart-heals-sibling-push.test.ts:22 (the 60 s watchdog).
   - memory-budget.test.ts:212 is a `test.for` table, and vitest cannot tag one row of it. Either tag the whole table, because every row is a heap-capped child process (14 more rows stop warning), or move the 3 rows into their own tagged `test.for`.
   - Define the tag in BOTH the unit project (vitest.config.ts:239) and the workers project (:304). `strictTags` defaults to true in vitest 4.1.11, so an undefined tag fails the row:
     `tags: [{ name: "waits", description: "Waits a real deadline on purpose; the Test job's row budget does not warn about it" }]`
   - Check once that the workers pool reports `test.tags`.

2. The finalizer's `unitRowBudget` keeps `tags` on each row and warns about `durationMs > UNIT_ROW_WARN_MS && !tags.includes("waits")`. It returns `[]` when nothing is over, and its message says "Make each faster, or tag it `waits` with its reason". Delete the stale-entry branch, and do not add a replacement detector.

3. dashboard.ts:528 becomes `const exempt = row.tags.includes("waits")`. Drop the import.

4. Delete `UNIT_ROW_WARN_EXEMPTIONS` (budgets.ts:96-120).

5. Slow-row files are scanned from the checkout.
   - slow-rows.ts exports `slowRowFiles(repoRoot)`. It walks apps/os/e2e and apps/agents/e2e and keeps the files that match `/\btags:\s*\[[^\]]*["']slow["']/u`, the regex moved from e2e-policy.test.ts:73.
   - `chooseSlowRows` gains an input, `slowRowFiles: string[]`, and preview.ts:805 passes it.
   - Delete `SLOW_ROW_PATHS` (budgets.ts:79-88), the exactness row (e2e-policy.test.ts:71-76) and slow-rows.test.ts:43-52.
   - Add one assertion that the checkout's scan is non-empty, so a regex that stops matching fails loudly.

6. Update the prose that names the registries: docs/testing.md:392/410/424, docs/vitest-patterns.md:42, apps/os/e2e/AGENTS.md:9, .depot/workflows/preview-os.yml:17 and the header of slow-rows.ts:4.

Option: reuse `slow` for unit and Workers rows instead of `waits`. That drops the dashboard's `exempt` branch, and flake-suite-summary.ts:82's use of the tag is limited to preview-e2e. But `slow` in e2e means "a PR skips it", so a second tag is clearer.

### Skeptic's verdict

The claim holds, and main already shows the registry drifting. The change is modest because it sits in test infra, not product code.

(a) Semantics. Of the 11 `UNIT_ROW_WARN_EXEMPTIONS` titles (budgets.ts:97-120), two no longer name any row:

- "a live session rides out a deploy's Durable Object reset…" was renamed in #3252. The row is now oauth-recheck-platform-failure.test.ts:17.
- "a revocation answers the very next call…" was deleted in #3440.

Also, facet-timeout-restart-heals-sibling-push.test.ts (a 60 s watchdog, and in LONG_POLES in apps/os/vitest.config.ts) was never listed. So every Test job prints spurious over-budget lines and stale-entry lines today. A tag moves with a rename and dies with its row, so that whole class of drift goes away.

The e2e half of the same budget already uses the tag as its exemption (retry-telemetry-reporter.ts:150 `!test.tags?.includes("slow")`). So today one job has two mechanisms. Tags reach unit and Workers artifacts too:

- the shared reporter writes them (reporter:160);
- ci-telemetry.ts:35 requires them;
- flake-suite-summary.ts:116 carries them;
- dashboard.ts:476 reads them.

Changed behaviours, all warnings or labels and never a verdict:

1. A renamed row keeps its exemption.
2. The stale-entry warning goes. A row tagged `waits` that stops waiting is silent. Don't re-add a 'tagged but fast' detector.
3. The warning text and the dashboard's "exempt" label change.
4. The memory-budget rows are one `test.for(rows)` table of 17 rows (memory-budget.test.ts:212). Vitest cannot tag one row of a table, so either the whole table is tagged (14 more child-process rows stop warning) or the 3 rows are split into their own table.
5. The slow-row files are read from the PR's checkout. Today they come from a list that CI forces to equal that same scan, so the result is the same whenever that test was green.

Two callouts in the candidate are wrong:

- dashboard.test.ts pins nothing about exemptions (a search for 'exempt' finds nothing).
- vitest 4.1.11 has `strictTags` on by default. @vitest/runner chunk-artifact.js:1717 throws on an undefined tag. So `waits` must be defined in the `tags` list of both the unit project (vitest.config.ts:239) and the workers project (:304), not "next to slow" in e2e. Tags inside the @cloudflare/vitest-plugin pool are validated by vitest's own runner, so this should work, but it is unproven.

(b) Simpler: yes. Five mechanisms become two:

- before: the `SLOW_ROW_PATHS` list, its exactness test (e2e-policy.test.ts:72-76), its per-entry recheck (slow-rows.test.ts:43-52), the title registry, and the stale detector (finalizer :123-125, :136-139);
- after: tags on rows, plus one scan.

Authors also lose a step. apps/os/e2e/AGENTS.md:9 currently says "and its file listed in SLOW_ROW_PATHS". The slow-row half on its own is small (about −10 net), but it follows the same rule.

(c) Guarantees. "A PR that edits a slow row's file runs the slow rows" is kept. The only thing lost is a narrow regex-rot check. If someone writes `tags: [SLOW]` and also lists the file, the exactness test fails today. After the change, a slow tag the regex cannot see drops the file from the set without any failure. A `toBeGreaterThan(0)` assertion on the scan keeps most of that.

(d) LOC, measured with sed ranges on the files:

- budgets.ts −37 (lines 79-89 and 95-121)
- finalizer about −14 (the import shrinks from 4 lines to 1, the stale branch goes)
- finalizer test about −14 (the 40-line block at 222-261 becomes about 26)
- e2e-policy.test.ts −6
- slow-rows.test.ts about −7
- slow-rows.ts about +9 (the scan)
- preview.ts +1
- dashboard.ts −1
- vitest.config.ts about +12 (two tag definitions)
- tagging about 11 rows about +8

Net is about −45 to −50 across about 14 files, not −55. Doc lines change wording only: testing.md:392/410/424, vitest-patterns.md:42, e2e/AGENTS.md:9 and preview-os.yml:17.

The tests that pin today's behaviour are e2e-policy.test.ts:72, slow-rows.test.ts:5-52 (the table rows gain an input, and 43-52 is deleted) and test-telemetry-finalizer.test.ts:222-261. PR #3446 (merged) touches none of these files.
