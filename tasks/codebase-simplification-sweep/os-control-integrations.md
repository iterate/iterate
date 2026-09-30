# Sweep candidates: os-control-integrations

Verified candidates from the 2026-09-29 codebase simplification sweep for this area. Each passed an adversarial skeptic check; where the skeptic amended the proposal, the amendment wins. Line numbers are as of origin/main on 2026-09-29 (about cfd8a1d36) and have drifted since: #3442, #3455 and #3460 touched some of these files. The index and the owner calls are in ../codebase-simplification-sweep.md.

## Slack's held-aside token goes: the route guard at use time is the one wall

- Sweep index: 25; risk: medium; payoff: 5/10
- LOC: Product: about −170 to −240, measured on origin/main ranges.
- Keeping the compare-and-clear drop (the parallel variant): about −170.
- Deleting it for `deleteTokenSecret`: about −240. By file: secret/durable-object.ts about −93 to −109, built-ins.ts −26 to −56, slack.ts about −44 to −68, verbs.ts about −6 to −11, connections.ts −3 to −8.

Tests:

- Deleted: integrations.test.ts:414-453 (40) and :825-845 (21).
- Flipped to 'refused on use': :262-273.

Tightening the guard saves about −15 more. (skeptic measured: Measured on origin/main b3daf4846. PR #3446 touches none of this code.

apps/os/src/secret/durable-object.ts, about −103:

- HeldExchange at 126-138: 13 lines.
- completeOAuth held replay at 729-737: 9.
- Hold and alarm claim at 798-805 and the held branch at 810-827: 26 (the revision fence at 806-809 stays).
- admitHeldToken with its doc: about 33.
- revive override at 902-915: 14.
- dropHeldToken's held branch at 924-928: 5.
- Doc and type lines: about 4.
- delete("held") at 547: 1.
- About +3 to put `team` on the answer and in `completed`.

context/built-ins.ts, about −27:

- admitHeldToken declaration at 140-143: 4.
- Its implementation at 1264-1283: 20.
- The held short-circuit at 1255-1256: 2.
- The "held" union member: 1.

integrations/slack.ts, about −39:

- The admitHeldToken wrapper at 256-270: 16.
- finishSlackConnect at 125-184 goes from 60 lines to about 40 once its two paths merge.
- Header: 2. connectMovedSlackTeam: 1.

Smaller files:

- verbs.ts and connections.ts: about −3.
- secret-oauth-callback.ts: 0, rename only.
- docs/integrations.md: about −2.

Product total: about −172. That matches the candidate's −170 variant. The −240 variant is not valid, because it drops a guarantee (point 2 of the amended proposal).

Tests in **workers-tests**/integrations.test.ts: about −46.

- The expiry row at 414-453 is deleted (41 lines).
- Row :244 loses its 5 admitHeldToken lines, and one secretPathsOf line flips.
- Row :825's assertion is rewritten.)
- Concepts: Before, 2 walls for one rule: the held slot (with admit, drop, alarm, revive, HeldToken and heldTokenNonce) and the use gate.

After, 1 wall: the use gate. Across providers, the job goes from 4 shapes to 3.

### Evidence

Merges the parallel and heavy hunts. Both mechanisms landed in #3242 (09-26).

The held-token path, in apps/os/src/secret/durable-object.ts:

- :126-137 HeldExchange
- :725-737 held replay
- :798-824 hold branch and its alarm claim
- :866-897 admitHeldToken
- :899-909 revive override
- :911-928 dropHeldToken

The guard that already covers the same case:

- :1089-1104 `#assertWorkspaceNotMoved`, run on every use at :687 (clientSecretFor) and :1012 (#serve, which lends go through too).

Plumbing:

- context/built-ins.ts:143-150 and :1257-1313
- secret-oauth-callback.ts:121-137
- integrations/verbs.ts:158-160, :181, :188-193 and :496-502
- slack.ts:140-177 and :246-283, including a 'released meanwhile' branch that copies the ordinary connect
- connections.ts:74-77 and :105-107

Other providers solve the same problem differently:

- x.ts:123-146 stores, then deletes on refusal.
- GitHub mints only through its route gate (:1068-1081).

### Current shape

When a Slack consent names a workspace that another project routes, the secret facet does not store the token. It keeps it encrypted in a `held` slot, claims the alarm to drop it at the offer's expiry, and exposes admitHeldToken and dropHeldToken. Each of those has a facet method, a built-in and a slack.ts wrapper.

Once stored, the token is refused on every use whenever another project holds the route anyway.

### Proposed shape

completeOAuth stores every exchange with its `routedAccount` and returns `team`. finishSlackConnect then has one path:

```ts
const holder = await controlPlane.integrationRouteOf('slack', team.externalId);
if (holder && holder.projectId !== projectId) return { move: offerMove(scope, connection, attempt, team, holder) }; // stored, refused on use
return { row: await routedWhile(env, route, async () => slackConnected(scope, connection, attempt, await slackIdentityOf(...))) };
```

- The move becomes: route CAS → auth.test → `slack/connected`.
- A failed move deletes the destination's token. Either keep the compare-and-clear (renamed `dropConsentToken`) or use `deleteTokenSecret`.
- Delete HeldExchange, the hold, its alarm, the revive override, admitHeldToken (all three layers), HeldToken and HeldTokenInput, and the `held` threading.
- To keep the guarantee exactly, tighten the guard to 'refused unless routed HERE'. That is GitHub's rule, and it merges with the secret-facet route-guard row.

### What changes

- The destination's secret is written at consent time. It shows in `secret/set` and in secrets.list(), but every use is refused while another project routes the workspace.
- An offer nobody confirms leaves a refused token stored until the next connect or disconnect, instead of an alarm deleting it.
- One real gap, unless the guard is tightened: if the holder project is deleted, its route vanishes without a revoke, and the destination could then use a token it never finished connecting.
- A refreshed callback re-offers by matching `team` instead of `heldTokenNonce`.
- The success path of a move is unchanged.

### Pinned by

- **workers-tests**/integrations.test.ts:244 (asserts no /secrets/slack-acme and a refused admitHeldToken)
- integrations.test.ts :307, :414, :825, :530, :884
- integrations.test.ts:846 (token refused on every use once moved) pins the wall that stays.

### Skeptic's amended proposal

**What completeOAuth does.** It stores every exchange, as it already does for the unheld path:

- `record.routedAccount` is set from the token response's team.
- `completed = { nonce, revision, scopes, team }`, so a replay answers the team too.
- The answer is `{ urls, refresh, exchanged, scopes, team?: { externalId, account } }`.

There is no route read in the facet, no `held` slot, no alarm claim and no revive override.

**What goes:**

- HeldExchange.
- The facet's admitHeldToken, the built-in admitHeldToken with its declaration, and the slack.ts admitHeldToken wrapper.
- The `until` field of HeldToken.
- The "released meanwhile" branch.

**The finish becomes one path:**

```ts
export async function finishSlackConnect(scope, connection, attempt, { team, consentNonce }) {
  if (attempt.client !== "iterate")
    return {
      row: await slackConnected(
        scope,
        connection,
        attempt,
        await slackIdentityOf(scope, attempt.origin, connection),
      ),
    };
  const holder = await new ControlPlane(scope.env).integrationRouteOf("slack", team.externalId);
  if (holder && holder.projectId !== scope.projectId)
    return { move: offerMove(scope, connection, attempt, team, holder, consentNonce) }; // token stored, refused on use
  const path = connectionPathOf("slack", connection);
  return {
    row: await routedWhile(
      scope.env,
      { provider: "slack", externalId: team.externalId, projectId: scope.projectId, path },
      async () => {
        const identity = await slackIdentityOf(scope, attempt.origin, connection);
        if (identity.teamId !== team.externalId)
          throw new Error(
            `Slack's auth.test names workspace ${identity.teamId}, not ${team.externalId}`,
          );
        return slackConnected(scope, connection, attempt, identity);
      },
    ),
  };
}
```

**The move** (connectMovedSlackTeam) becomes auth.test, then a check that the team matches, then `slack/connected`.

**A failed move** calls the compare-and-clear, renamed `dropConsentToken(nonce)`. It keeps today's check and clear: `completed.nonce === nonce && stored.revision === completed.revision`. It keeps its built-in's `secret/deleted`, the lend ending and the processor disable. Only the `held` branch goes. `heldTokenNonce` becomes `consentNonce`. verbs.ts always tries `slackMoveOfferedAgain(nonce)` for Slack when no attempt is left.

**Do not tighten `#assertWorkspaceNotMoved` to "routed HERE".** revokeSlack calls auth.revoke after its route release (slack.ts:336-343), so a tightened guard would silently disable revokes. Leave the guard exactly as it is.

**Do not use deleteTokenSecret for a failed move.** It would delete a member's newer write, which test :825 pins.

**Tests:**

- Delete :414-453.
- At :244, assert that /secrets/slack-acme is listed and that auth.test answers 502 before the confirm.
- At :825, assert that the move fails on auth.test with the member's own token, the route goes back, and the member's secret is kept.

**Needs Jonas's sign-off.** An unconfirmed offer now leaves a refused token stored and a `secret/set` fact on the log. #3242 deliberately avoided exactly that.

### Skeptic's verdict

The core claim holds. The held slot and the use gate enforce one rule: the destination project cannot use a workspace's token while another project routes that workspace. The use gate (`#assertWorkspaceNotMoved`, called at :687 and :1018) has to exist anyway. It covers:

- the holder after a move;
- the ordinary connect's race, where the token is already stored when another project takes the route. Today that race leaves a stored token that is refused on use.

The held slot is therefore a second wall, and it costs a lot:

- its own encrypted-at-revision slot;
- a nonce-matched admit at three layers;
- an alarm claim and a revive override with a re-claim;
- a duplicated "released meanwhile" connect path.

Storing the token and refusing it on use matches X, which stores and deletes on refusal. It collapses finishSlackConnect into one path.

The candidate has three things wrong or missing.

1. Its "tighten the guard to routed HERE" add-on breaks disconnects. revokeSlack (slack.ts:336-343) releases the route first and only then calls auth.revoke through egress. That call passes through `#serve`'s guard, so under "routed HERE" it gets a 502. The `.catch(() => {})` swallows it, so a disconnect would silently stop revoking Slack tokens. Tightening would also force the ordinary connect to route before its auth.test. Drop the add-on.

2. The −240 variant (deleteTokenSecret on a failed move) drops a guarantee. Test :825 pins that a failed move leaves a member's newer write to the secret alone. Keep the compare-and-clear, renamed.

3. Its example of the real gap is wrong. Deleting a project never touches integration_routes: only disconnect, move and undo paths release routes. So a deleted holder's route stays, and the destination stays refused.

The actual behaviour changes:

(a) An unconfirmed or cancelled offer leaves `/secrets/slack-<conn>` stored and refused, with no connection row. It shows in secrets.list(), it wrote a `secret/set` fact, and it stays until the next connect or a manual delete. Today the alarm drops it after 10 minutes. PR #3242's risk map explicitly celebrated "now it never is [stored]", so this reverses a stated decision, and Jonas has to make that call.

(b) The destination can use a token it never finished connecting only if the workspace ends up routed nowhere while the token is still live. That happens when the holder's best-effort auth.revoke fails, or in the milliseconds between release and revoke. The guard already treats "routed nowhere" as usable for ordinary connects, and the human proved install rights through Slack's consent.

(c) A move uses whatever the connection's secret holds when it is confirmed, checked by auth.test. Today it refuses "no token is held" once anything was written since. Row :825's regex changes.

(d) A refreshed callback replays through `#completed`, which must now carry `team`.

(e) The `held` threading from completeOAuth through the built-in, the callback and FinishConnectInput to finishSlackConnect stays, renamed to `team` with id and name. So the plumbing savings are smaller than claimed: built-ins about −27, verbs and connections about −3, the callback 0.

Concepts, before and after:

- Removed: the storage slot, the admit verb at three layers, the alarm obligation and revive override, and one connect branch.
- Kept: the use gate, the compare-and-clear drop and the consent nonce.

Risk is medium. This is the path #3242 flagged as riskiest, and it took 8 Codex rounds, though the change removes code rather than adds it.

Tests that pin the current behaviour:

- integrations.test.ts:244: asserts no /secrets/slack-acme and a refused admitHeldToken.
- :414: the expiry row, deleted.
- :825: its assertion changes.
- :307, :530 and :884 should pass unchanged under compare-and-clear.
- :846 pins the wall that stays.

## A failed move is recovered forward by the same offer, not by a compensating undo held together by three race guards

- Sweep index: 26; risk: high; payoff: 5/10
- LOC: Product: about −175, measured with sed and wc.
- verbs.ts: about −48 (+5 for the new message)
- connections.ts: −35
- catalog.ts: −24
- edge.ts: −12
- integration-routes.sql: −13
- generated code: −42
- docs: about −8

Dropping the re-proof saves about −11 more.

Tests:

- integrations.test.ts: seven rows (:493, :530, :636, :682, :772, :884, :1374) total 272 lines.
- control-plane-catalog.test.ts:849-870: 22 lines.
- These become about 30–60 lines of resume rows, for about −240 net. (skeptic measured: Product: about −185.
- verbs.ts: about −46. moveHere is 99 lines at :459-557 and becomes about 60. The disconnect loses 3, the import 1, and the JSDoc about 3.
- connections.ts: −35 (:252-286).
- catalog.ts: −25 (:809-832, plus the import).
- edge.ts: −12 (:519-530).
- integration-routes.sql: −14 (:45-58).
- generated integration-routes.sql.ts: −42 (:181-222).
- apps/os/docs/integrations.md: about −8.
- slack.ts: about −3.

Tests: about −265.

- integrations.test.ts: rows 493, 530, 636, 682, 772, 884 and 1374 are 37 + 30 + 46 + 43 + 53 + 31 + 32 = 272 lines.
- control-plane-catalog.test.ts:849-870: 22 lines.
- Add about 30 lines for one forward-retry row.)
- Concepts: Before: 2 recovery mechanisms (a compensating undo with 3 race guards, plus the forward retry) and 7 route verbs; 'moving' works as a lock.
  After: 1 mechanism (the forward retry) and 6 route verbs.

### Evidence

This row merges the parallel and heavy hunts.

The undo, in apps/os/src/integrations/verbs.ts:459-557 (moveHere):

- :513-553 is the undo itself: holderNamesIt is read twice, then restoreIntegrationRoute, then a release from either side, then a re-route of the destination's previous account.
- :490-491 reads `before`, which only the undo uses.
- :479-487 is the 'already under way' refusal.

The three race guards that keep the undo safe:

- verbs.ts:361-363: disconnect releases the routes a second time.
- connections.ts:252-286: `connectionRowThroughHeadOf`, whose only caller is the undo.
- The restore statement, spread across catalog.ts:809-832, edge.ts:519-530, integration-routes.sql:45-57 and the generated integration-routes.sql.ts:180-221.

The forward retry already exists for the holder's cleanup (verbs.ts:402-454, stage 'moved').

Other context:

- apps/os/docs/integrations.md:69-77 spends 9 lines on the undo's races.
- The 'moving' claim guards a concurrency that project/durable-object.ts:290-299 already serializes.

### Current shape

A confirmed move compare-and-swaps (CAS) the route to the destination, then connects there.

If the connect fails, a compensating undo runs. It restores the route under a guarded second CAS while the holder still names the account, reads again, releases, re-routes the destination's previous account, and spends the offer.

A failed holder cleanup, by contrast, is already retried forward by the same offer.

### Proposed shape

```ts
if (move.stage !== "moved") {
  await controlPlane.moveIntegrationRoute(provider, externalId, holder, { projectId, path }); // CAS; already here = success
  await connectHere().catch((error) => {
    throw codedError(
      "INVALID_INPUT",
      `${account} moved here, but connecting it failed (${messageOf(error)}) — press Move again.`,
    );
  });
  await scope.storage.put(key, { ...attempt, move: { ...move, stage: "moved" } });
}
```

- Only a refused CAS abandons the offer.
- Delete: restoreIntegrationRoute (SQL, catalog, edge and generated code), connectionRowThroughHeadOf, the undo, the second release in disconnect, the 'already under way' refusal, and the doc paragraph.
- Optional further step from the heavy variant: drop the move-time provider re-proof (GitHub's mint and repositories calls, Slack's auth.test). The callback already proved the account, and without the re-proof only platform writes follow the CAS.

### What changes

Only the failure path changes.

When a connect fails, the route now stays at the destination and the same offer retries. Until that retry:

- the account's webhooks land on a connection log with no `connected` row;
- the holder's token is refused within the 30 s route re-check;
- a GitHub reconnect leaves the destination's previous installation unrouted.

After the offer's 10 minutes, the state is left for either side to fix. A confirm that crashed mid-move becomes retryable instead of blocked.

If the re-proof is dropped: an account that died between callback and confirm (at most 10 minutes) connects, then fails on first use.

### Pinned by

- integrations.test.ts:493, :530, :636, :682, :772, :884, :1374
- control-plane-catalog.test.ts:849
- integrations.test.ts:364 and :1346 pin the forward retry that stays.

### Skeptic's amended proposal

One sentence: every expected refusal comes before the route moves, and after it only idempotent platform writes follow, which the same offer retries forward.

In moveHere (verbs.ts):

```ts
if (move.stage !== "moved") {
  const path = connectionPathOf(provider, connection);
  try {
    // the held token in the secret first: refused on use while another project holds the workspace
    // (secret/durable-object.ts #assertWorkspaceNotMoved)
    if (provider === "slack") await admitHeldToken(scope, connection, move.heldTokenNonce || "");
    await new ControlPlane(env).moveIntegrationRoute(provider, externalId, holder, {
      projectId,
      path,
    });
  } catch (error) {
    await abandon();
    throw error;
  }
  // only the platform's own writes follow; the same offer finishes them
  await (
    provider === "github"
      ? connectGithubInstallation(scope, connection, attempt, externalId, account, "held") // held: mint strategy + connected, no proof
      : slackConnected(scope, connection, attempt, { teamId: externalId, team: account })
  ).catch((error) => {
    reportIssue("integrations.move-connect", error, { provider, externalId, projectId });
    throw codedError(
      "INVALID_INPUT",
      `${account} moved here, but connecting it did not finish — press Move again.`,
    );
  });
  await scope.storage.put(key, { ...attempt, move: { ...move, stage: "moved" } });
}
```

Delete:

- the `moving` claim and the "already under way" refusal;
- `before`;
- the undo;
- `restoreIntegrationRoute`: its SQL, catalog, edge and generated code;
- `connectionRowThroughHeadOf`;
- disconnect's second `releaseIntegrationRoutes`;
- the provider proof on the move path: GitHub's `prove` when `routing === "held"`, and Slack's `auth.test` in `connectMovedSlackTeam`, which reduces to admit before the swap plus `slackConnected`;
- the undo paragraph in the integrations doc (apps/os/docs/integrations.md:69-77).

Tests:

- Delete rows 493, 530, 636, 682, 772, 884 and 1374, and catalog row 849.
- Keep 825 unchanged: the admit refuses before the swap, so the holder keeps the route.
- Add one row: a failed append after the route moved is reported, and "Move again" on the same offer finishes it.

### Skeptic's verdict

As written, this candidate drops a real guarantee. With the amendment below it keeps that guarantee more simply, so I'm keeping it only in amended form.

**What holds (checked in wt-main; PR #3446 touches none of these files):**

- `connectionRowThroughHeadOf` (connections.ts:252-286) and `restoreIntegrationRoute` (catalog.ts:809-832, edge.ts:519-530, SQL :45-57, generated :181-222) each have one caller, the undo. The catalog also has one test row for it, :849-870.
- The second release in disconnect (verbs.ts:361-363) exists only for the undo's race, as its own comment says.
- `#onConnection` (project/durable-object.ts:222-245) runs in memory and one verb at a time. So stage `moving` and "already under way" are only ever seen after a crash mid-move. Today that crash blocks the offer until it expires.
- `moveIntegrationRoute` already succeeds when the route is already at `to`: the batch reads the holder back, catalog.ts:803-804.
- `admitHeldToken` replays through `completed`.
- So a forward retry is sound.

**What is wrong as specified (a, c):**

- The proposal keeps provider calls after the compare-and-swap (CAS): GitHub's mint and the `/installation/repositories` proof, Slack's `auth.test`. It also keeps `admitHeldToken` after the CAS, which refuses permanently for ordinary reasons:
  - the destination wrote the secret, or began a new consent;
  - the held token's `until` passed. It is set at the exchange, a few milliseconds before the offer's.
  - An inactive account or a broken App key also fails every retry.
- The same offer can never succeed then, and the result is lasting cross-project state that disagrees with itself:
  - the holder is a project whose members may not know about the move;
  - the holder's row still says connected, but it gets no webhooks, and its token is refused within 30 s;
  - the destination has no `connected` row;
  - for a GitHub reconnect to another installation, the destination's own previous installation is unrouted and refused.
- docs/engineering-invariants.md forbids exactly this ("leaves corrupt, stalled, or divergent state behind"; recovery must be bounded).
- `pinnedBy` misses integrations.test.ts:825. That row, "held token gone", asserts the route stays with the holder, and it would flip.
- The cleanup's forward retry is not a second mechanism doing the same job. After the cleanup fails, the account works at the destination. After a connect fails, it works nowhere.
- A live offer after a failure also re-arms: in row 682's case, "Move again" retakes the account the holder has just moved back. Today that offer is spent.

**The amendment that keeps the guarantee more simply (b):**

- Every expected refusal goes before the CAS: the offer checks, and for Slack `admitHeldToken`.
  - A token admitted this early is safe. Its record carries `routedAccount` (secret/durable-object.ts:797), so `#assertWorkspaceNotMoved` refuses every use while the holder still holds the route. If the CAS is refused, the existing `abandon` → `dropHeldToken` clears it.
- The provider re-proof at confirm goes. The callback proved the account at most 10 minutes earlier.
- After the CAS come only the platform's own idempotent writes:
  - GitHub: `secrets.list`/`set`, then `appendConnected`;
  - Slack: `appendConnected`, built from the offer's `move.externalId` and `move.account`.
  - The same offer retries these. They can only fail on a platform fault, which is reported.
- Then the undo, `before`, `restoreIntegrationRoute`, `connectionRowThroughHeadOf`, the disconnect's second release and stage `moving` all go.
- Today's holder-intact guarantee survives every expected failure. Test 825 keeps passing unchanged.

**Concepts:**

- Before: 2 recovery mechanisms, the compensating undo with 3 race guards and the forward retry. 7 route verbs. 2 row reads. Stages `moving` and `moved`.
- After: 1 recovery mechanism, the forward retry. 6 route verbs. 1 row read. Stage `moved` only.

**LOC, re-measured (d):**

- verbs.ts: about −46.
  - `moveHere` is 99 lines and becomes about 60.
  - The disconnect loses 3 lines, the import 1, and the doc comment about 3.
- connections.ts: −35.
- catalog.ts: −25.
- edge.ts: −12.
- integration-routes.sql: −14.
- Generated code: −42.
- integrations.md: about −8.
- slack.ts: about −3.
- Product total: about −185.
- Tests:
  - Delete rows 493, 530, 636, 682, 772, 884 and 1374, 272 lines measured between test starts, plus the catalog's 22 lines at :849-870.
  - Add one row, about 30 lines, where a write after the route moved fails and the same offer finishes it.
  - Test net: about −265.

**Risk: medium.**

- It moves the Slack admit before the CAS.
- It drops the confirm-time liveness proof: an account that died between the callback and the confirm connects, then fails on first use.
- A platform fault after the CAS becomes a forward retry instead of an undo.
- A crash mid-move becomes retryable instead of blocked.

**Pinned today by:**

- integrations.test.ts:493, :530, :636, :682, :772, :825, :884, :1374 and control-plane-catalog.test.ts:849.
- Rows :364 and :1346 pin the forward retry that stays.

## ControlPlane stops re-declaring 26 catalog methods, 8 of them under a second name, only to wrap each in the same failure mapping

- Sweep index: 27; risk: medium; payoff: 6/10
- LOC: About −145 to −160 product lines net:
- edge.ts: 583 → about 365–430
- db/index.ts: 19 → about 75
- catalog.ts: about +4

About 33–40 call sites are renamed in place (for example, `oauthGrant` 12 hits, `integrationRouteOf` 9, `releaseIntegrationRoute` 7). (skeptic measured: Measured with sed over the 11 cited ranges of apps/os/src/control-plane/edge.ts (583 lines):

- 74-76, 94-157, 172-177, 219-224, 328-357, 360-364, 369-380, 434-447, 470-473, 486-548 and 559-576 hold 225 removable lines: the 26 forwarders with their docs, `#read`/`#withinDeadline`/`#call` and `callerOf`.
- `this.#call`/`this.#read` appears 42 times.
- The 11 remaining overrides each shrink by about 1 line, for about −10 to −15.
- edge.ts: 583 → about 345.

Additions:

- db/index.ts: 19 → about 70–85 (the guard moves there with its comment).
- catalog.ts: +3 to +6 (constructor, `now` defaults, the `.cause` check).
- oauth-grants.ts: +0 to +3.

Net: about −165 to −185 product lines, a little more than the candidate's −145 to −160.

Call-site renames are 0 net and touch about 60 lines. `getProject`/`getUser` alone have 37 hits across 18 files, `integrationRouteOf` has 9, and the grant verbs 5. Tests change 0 net lines, with message strings edited in 5 files.)

- Concepts: Before: 2 names for 8+ operations, 26 forwarding methods, callerOf, and a 3-level per-method failure wrapper.
  After: 1 name per operation, one failure boundary at the D1 chokepoint, and 12 overrides that keep, forget or decide.

### Evidence

Merges the parallel and heavy hunts.

- apps/os/src/control-plane/edge.ts has 26 pure pass-throughs, 156 lines in total: :172-176, :219-223, :328-356, :360-380, :434-447, :470-473, :486-548 and :559-575.
- `callerOf` at :74-75 outputs a Pick that catalog.ts:82 already declares.
- The failure wrappers `#read`, `#withinDeadline` and `#call` are at :94-156.
- Operations with two names (edge / catalog): getUser/user, listUsers/users, listOrganizations/organizations, listMembers/members, listInvitations/openInvitations, getInvitation/invitation, integrationRouteOf/integrationRoute, getProject/project, and the oauth-grant verbs.
- Every catalog access goes through `batch()` (db/index.ts:18-19) or a sqlfu client call that carries a `name`.
- Only 12 edge methods add anything: caching, invalidation, or reach.

### Current shape

ControlPlaneDatabase holds the SQL. ControlPlane re-declares two thirds of it as one-line forwarding under a second set of names, so it can map D1 platform failures to UNAVAILABLE and apply /api's read deadline per method.

### Proposed shape

```ts
// db/index.ts — the one place a platform D1 failure becomes UNAVAILABLE
export function controlPlaneD1(
  d1: D1Database,
  { readDeadlineMs }: { readDeadlineMs?: number } = {},
) {
  const client = createD1Client(d1);
  return {
    client: {
      ...client,
      all: (q) => guarded(q.name, () => client.all(q), readDeadlineMs),
      run: (q) => guarded(q.name, () => client.run(q)),
    },
    batch: (qs, { read = false } = {}) =>
      guarded(
        qs.map((q) => q.name).join("+"),
        () => d1.batch(qs.map(prepared)),
        read ? readDeadlineMs : undefined,
      ),
  };
}
// catalog.ts: one name per op, `now = Date.now()` defaults, takes Caller
export class ControlPlane extends ControlPlaneDatabase {
  /* the 12 cache-bearing overrides + reach helpers */
}
```

A variant exposes `controlPlane.catalog` instead of subclassing. Either way the 26 pass-throughs, `callerOf` and the per-method wrappers go.

### What changes

- UNAVAILABLE messages and the `control-plane.platform-failure-d1` log name the sqlfu statement instead of the method. For example, `projectsByRef` instead of `project`, and `accessibleOrganizations+accessibleProjects` instead of `accessibleTo`.
- The /api read deadline attaches to `client.all` and to read batches, which is the same set of calls as today.
- Scripts and tests that build ControlPlaneDatabase directly also get the mapping.
- No guard, cache TTL or invalidation changes.

### Pinned by

- **workers-tests**/control-plane.test.ts:517, :532, :552 ('failed ${method}', 'failed user')
- oauth-recheck-platform-failure.test.ts:53-93
- project-host-control-plane-down.test.ts:42-46, :100-128
- oauth.test.ts (grant store retry)
- control-plane-catalog.test.ts (calls catalog names with explicit `now`)

### Skeptic's amended proposal

- **db/index.ts:** replace `batch` with `controlPlaneD1(d1, { readDeadlineMs }?)`, which returns `{ client, batch }`.
  - `client` is sqlfu's D1 client. Its `all` is guarded and carries the deadline. Its `run` is guarded with no deadline.
  - `batch(queries, { read = false } = {})` is guarded, and carries the deadline only when `read`.
  - `guarded(name, call, deadlineMs?)` is today's `#call` and `#withinDeadline` bodies moved verbatim. It still rethrows a non-platform SqlfuError as `new Error("The control plane failed <name>: …", { cause })`.
  - `name` is the statement's sqlfu `name`. For a batch, the names are joined with `+`.
- **catalog.ts:**
  - `ControlPlaneDatabase` takes `(d1, options?)` and builds that pair.
  - `batch(this.#d1, …)` becomes `this.#batch(…)`, with `{ read: true }` on `accessibleTo` and `openInvitations` only.
  - Every `now` parameter defaults to `Date.now()`.
  - `linkIdentity`'s catch (catalog.ts:317) tests `error.cause instanceof SqlfuError && error.cause.kind === "unique_violation"`. Without this, IDENTITY_CONFLICT on a provider email collision breaks (identity.test.ts:129-133).
- **oauth-grants.ts:** `OAuthGrantTable` takes the same pair, and `now` defaults to epoch seconds. The edge exposes it as `readonly grants`, and oauth-store.ts calls `controlPlane.grants.get/list/put/delete`.
- **edge.ts:** `export class ControlPlane extends ControlPlaneDatabase`, with `constructor(env, options) { super(env.DB, options) }`. It keeps only:
  - `override project(ref, fresh = false)`, which is cached (this was `getProject`);
  - `override accessibleTo(userId, fresh = false)`;
  - `projectHostOf`, `projectIdOf`, `reachesProject`, `reachableProjectId`, `reachableProjects`, `reachesOrg` and `ensureUser`;
  - 9 write overrides shaped like `const r = await super.addMember(caller, orgId, input); forget(r); return r` (`createOrganization`, `renameOrganization`, `deleteOrganization`, `addMember`, `removeMember`, `acceptInvitation`, `createProject`, `deleteProject`, `setPrimaryHostname`).

  The 26 forwarders, `callerOf` and the three private wrappers go.

- **Callers** switch to the catalog's names: `user`, `users`, `organizations`, `members`, `openInvitations`, `invitation`, `integrationRoute`, `project` and `grants.*`.
- **Accepted deltas, to state in the PR:**
  - Messages and logs name statements, not verbs.
  - /api's deadline now covers the pre-write reads of `projectToDelete`/`deleteProject` and `createOrganization`'s owner lookup.
  - A late `accessibleTo` answer is no longer kept after the deadline trips.
  - `projectToDelete`'s row read goes through the edge's 5 s cache. The delete statement re-checks the row, and a row's orgId never changes.

### Skeptic's verdict

The core claim holds. edge.ts has exactly 26 pure forwarders, which I counted against the cited ranges. They exist only to attach a verb name to a failure wrapper, and 8 or more of them rename the operation. `callerOf` (:75) does nothing at runtime, because the catalog reads only `caller.principal`. Every D1 call already passes through two places: sqlfu's client `all`/`run`, where each generated query carries a `name`, and `batch()` in db/index.ts. So one failure boundary there is the natural chokepoint. It also fits the "close the class at the door" doctrine. PR #3446 does not touch src/control-plane, and it has already merged.

The proposal is mis-specified in five places. The semantics delta it lists is incomplete, and in one place wrong.

(1) SqlfuError scrubbing moved to the chokepoint would rewrap the error before catalog.ts:317 sees it. That catch is `linkIdentity`'s `error instanceof SqlfuError && kind === "unique_violation"`, from `updateUserEmail` via `client.run`. A provider email change onto an address another account holds would then throw a plain Error instead of IDENTITY_CONFLICT. identity.test.ts:129-133 pins this. The catch must read `error.cause`.

(2) "The same set of calls as today" is false for the read deadline. `projectToDelete`, and through it `deleteProject`, runs two `client.all` reads (`projectsByRef`, `organizationRole`) under `#call`, which has no deadline today. `createOrganization`'s owner lookup does the same. Under the chokepoint, /api's 5 s deadline covers all three. Each read comes before its write, so a trip writes nothing and the change is benign, but it is a change.

(3) Today `accessibleTo` keeps a late answer that arrives after the deadline (edge.ts:103, :240-247). An override that awaits `super` loses that.

(4) With `extends`, renaming `getProject` to `project` makes catalog's `projectToDelete` call `this.project(ref)`, and that call now reaches the cached override. A row deleted on another isolate within 5 s passes the pre-check. The delete statement still refuses it with the same FORBIDDEN message, and a row's orgId never changes, so no guarantee is lost. The `.catalog` variant avoids this, but it exposes raw writes that skip `access.clear()`/`#forget`, which is a real footgun. Use the subclass.

(5) OAuthGrantTable also needs the guarded pair, with a `now` default. The edge's four grant verbs become `controlPlane.grants.*`.

No guarantee is dropped once these are amended. Platform failures still become UNAVAILABLE of the same kind, SQL and bind values still never reach /api, and the deadline, guards, TTLs, invalidations and oauth-store's retry are unchanged.

The new shape is genuinely simpler. It has one name per operation and one failure boundary instead of 42 `#read`/`#call` sites and a three-level per-method wrapper. It also removes the facade layer, at the cost of a single, visible inheritance edge.

The cost is about 60 renamed call-site lines across roughly 20 files, plus message strings in five test files.

Remaining semantic delta:

- Error messages and log `name` fields name sqlfu statements instead of verbs, for example `userByRef` or `accessibleOrganizations+accessibleProjects`, and /api clients see these.
- Items (2)-(4) above.
- A ControlPlaneDatabase built directly, as in tests or support.ts `catalog()`, now maps failures too.

Pinned by:

- control-plane.test.ts:517-560, and :623 (direct ControlPlaneDatabase)
- oauth-recheck-platform-failure.test.ts:53-93
- project-host-control-plane-down.test.ts:42-46, :100, :128-134
- oauth-store.test.ts:39, :56
- identity.test.ts:129-133 (the unique_violation path)
- control-plane-catalog.test.ts:22, :889 (constructors)
- support.ts:148, :152

scripts/ci/platform-failures.ts parses only the text after the colon, so it is unaffected. prd-fault-alarm does not key on `name`.

Risk: medium. This is the central module, and the fix for (1) is required.

## reachesProject and reachableProjectId are one admission, and 'kept, then fresh once' is spelled four times

- Sweep index: 28; risk: low; payoff: 3/10
- LOC: edge.ts:250-326 goes from 77 lines to about 50, about −27. One file. (skeptic measured: I spliced both shapes into a copy of edge.ts and ran oxfmt (print width 100) before counting:
- Original edge.ts is 583 lines.
- The candidate's full proposal, with #accessHolding and honest docstrings, is 576 lines: −7 net (25 added, 32 removed).
- The amended version (admission merge plus the cap guard, no helper) is 571 lines: −12 net (10 added, 22 removed).

The candidate's "−27" does not survive formatting or the helper's own cost.)

- Concepts: 2 project-admission implementations become 1, and 4 kept-then-fresh loops become 1 helper.

### Evidence

In apps/os/src/control-plane/edge.ts:

- :254-266 reachesProject: returns a boolean and resolves slugs through a catalog project read.
- :274-286 reachableProjectId: returns the id and resolves slugs through the access record. Its non-user branch calls reachesProject.
- :294-313 reachableProjects.
- :317-326 reachesOrg.
- The 'kept, then fresh once' re-read is hand-written at :263-264, :282-283, :304-305 and :323-324.

Every product caller passes a `prj_` id to reachesProject: worker.ts:368, project-host-lease.ts:57, email.ts:88, github.ts:485, connections.ts:138, secret-oauth-callback.ts:63 and secret/durable-object.ts:484.

### Current shape

Two functions answer 'may this reach open this project', and each calls into the other's logic. Four readers each hand-spell 'read the kept access; if it lacks what we need, read it fresh once'.

### Proposed shape

```ts
async #accessHolding(userId: string, holds: (record: AccessibleRecord) => boolean) {
  const kept = await this.accessibleTo(userId);
  return holds(kept) ? kept : this.accessibleTo(userId, true);
}
async reachesProject(reach: Reach, ref: string) { return (await this.reachableProjectId(reach, ref)) !== null; }
async reachableProjectId(reach: Reach, ref: string) {
  if (reach === 'every' || !('userId' in reach)) { const id = await this.projectIdOf(ref); return id && (reach === 'every' || reach.projectIds.includes(id)) ? id : null; }
  const named = (r: AccessibleRecord) => r.projects.find((p) => p.id === ref || p.slug === ref);
  const project = named(await this.#accessHolding(reach.userId, (r) => Boolean(named(r))));
  return project && (!reach.projectIds || reach.projectIds.includes(project.id)) ? project.id : null;
}
```

reachesOrg and reachableProjects use #accessHolding too.

### What changes

Two behaviours change, and neither changes any current answer, because every caller passes ids:

- For a user reach, reachesProject resolves a slug from the kept access record instead of a kept catalog row. That is what reachableProjectId, /mcp and projects.get already do.
- A capped user reach reads the kept access before refusing an uncovered id.

### Pinned by

- **workers-tests**/oauth.test.ts:353, :844
- project-lookups.test.ts:31
- project-host-control-plane-down.test.ts:75-104
- control-plane.test.ts:24
- control-plane-contexts.test.ts:353

### Skeptic's amended proposal

Keep only the admission merge, add a cap-first guard, and drop #accessHolding. Leave reachableProjects and reachesOrg as they are. In apps/os/src/control-plane/edge.ts:

```ts
/** Whether `reach` reaches `ref` (`reachableProjectId`) — a project host's visitor (worker.ts). */
async reachesProject(reach: Reach, ref: string): Promise<boolean> {
  return (await this.reachableProjectId(reach, ref)) !== null;
}

/** The id of the project `ref` (its id or its slug) names, when `reach` reaches it, else null —
 *  the admission behind `projects.get`, a `/mcp` tool's `project` and a project host's visitor.
 *  The admin reaches a project the catalog never heard of by its `prj_…` id, never by a slug
 *  nobody holds; a named reach is its list; a user's is their access record (every slug they can
 *  reach, so a slug costs no catalog read) — re-read once before a refusal. */
async reachableProjectId(reach: Reach, ref: string): Promise<string | null> {
  if (reach === "every" || !("userId" in reach)) {
    const id = await this.projectIdOf(ref);
    return id && (reach === "every" || reach.projectIds.includes(id)) ? id : null;
  }
  if (reach.projectIds && ref.startsWith("prj_") && !reach.projectIds.includes(ref)) return null;
  const named = (record: AccessibleRecord) =>
    record.projects.find((project) => project.id === ref || project.slug === ref);
  const project =
    named(await this.accessibleTo(reach.userId)) ??
    named(await this.accessibleTo(reach.userId, true));
  if (!project || (reach.projectIds && !reach.projectIds.includes(project.id))) return null;
  return project.id;
}
```

**Semantics change:**

- For a user reach given a slug, reachesProject resolves it through the access record instead of a kept catalog row. No caller passes a slug.
- For projects.get, a capped reach on an uncovered `prj_` id is refused before any access read. Today it reads first, so it could fail UNAVAILABLE during a D1 outage; now it is FORBIDDEN.

Nothing else changes. Without the guard line, a project-bound bearer on another project's host would gain 1-2 D1 reads and get a 503 during an outage, instead of going on anonymous as it does today.

**Size and risk:** 583 → 571 lines in edge.ts, −12 net (10 added, 22 removed, measured after oxfmt). Two admission implementations become one. Risk is low.

### Skeptic's verdict

The claim holds only in part.

**The "one admission" half is real.** In apps/os/src/control-plane/edge.ts on main at b3daf4846, reachesProject (:254-266) and reachableProjectId (:274-286) answer the same question but resolve slugs two different ways. reachesProject goes through the catalog via projectIdOf/getProject; reachableProjectId goes through the access record. They also call each other: reachableProjectId's non-user branch calls reachesProject. Each docstring explains itself by pointing at the other, which fits "hard to explain = smell". PR #3446 does not touch edge.ts.

I checked all seven reachesProject callers:

- worker.ts:368 passes the host's projectId.
- project-host-lease.ts:57 passes the leased id.
- email.ts:89 passes project.id.
- github.ts:491 passes the signed claims.projectId.
- connections.ts:138 passes holderProjectId.
- secret-oauth-callback.ts:63 passes the owner id from resourceScope.
- secret/durable-object.ts:484 passes a borrower, which is a DurableObjectNameCodec projectId.

Every one is a `prj_` id. So for a user reach, resolving slugs through the access record changes no current answer.

**(a) The candidate's second delta is not harmless.** Authorization at the project host (oauth.ts:277) admits a project-bound bearer on any project's host. Today a capped reach `{userId, projectIds}` on an uncovered id is refused with no I/O. Under the proposed shape it would first do one access read, or two if the person is not a member. If D1 is down, worker.ts:368 would then throw a 503 where today the visitor simply goes on anonymous. One line keeps today's behaviour: check the cap first for `prj_` refs. The `startsWith` is required, because MCP passes slugs from capped OAuth grants (oauth.test.ts:353). With that line, answers and I/O stay identical for every current caller. For projects.get, a capped reach on an uncovered id then returns FORBIDDEN with no read, where today it reads first. That is harmless.

**(b) The #accessHolding helper is not simpler.**

- It is a private method that takes a predicate, and it has to be written with a docstring.
- It turns reachableProjects into a `fresh ? accessibleTo(userId, true) : #accessHolding(...)` fork.
- It saves about 2 lines per site and costs about 9.
- The existing `x(await kept) || x(await fresh)` two-liners read plainly, and "spell it twice" favours leaving them.
- Drop the helper.

**(c) No guarantee is dropped by the amended shape:**

- A user's access is still read fresh once before a refusal.
- The admin still reaches a project the catalog never heard of by its `prj_` id.
- A slug nobody holds still names nothing.
- A named reach is still its list.
- The cap still holds.

I typechecked the narrowing on `Reach` under strict tsc.

**(d) Measured LOC is well below the candidate's −27.** The candidate's one-liners break past the 100-column print width. I spliced both variants into a copy of edge.ts and formatted it with oxfmt.

- The full proposal is 583 → 576 lines, −7 net (25 added, 32 removed).
- The amended version (admission merge plus the cap guard, no helper) is 583 → 571 lines, −12 net (10 added, 22 removed). One file.

**Concepts:** two project-admission implementations with mutual calls become one, and the four kept-then-fresh re-reads stay as they are.

**Tests that pin the behaviour:**

- oauth.test.ts:353: an MCP slug is found in the access record with no catalog read.
- project-host-control-plane-down.test.ts:87-104: a member's failed access read answers 503.
- oauth.test.ts:844: consent's fresh re-read. Untouched.
- src/project-host-sign-in.test.ts is only a verdict table.

No test spies on reachesProject itself.

**Payoff is small:** a real concept reduction in a central file, but a modest line count.
