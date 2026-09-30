# Sweep candidates: os-project-repo-secret

Verified candidates from the 2026-09-29 codebase simplification sweep for this area. Each passed an adversarial skeptic check; where the skeptic amended the proposal, the amendment wins. Line numbers are as of origin/main on 2026-09-29 (about cfd8a1d36) and have drifted since: #3442, #3455 and #3460 touched some of these files. The index and the owner calls are in ../codebase-simplification-sweep.md.

## The config-template reader uses git-wire's transport instead of a second git smart-HTTP client

- Sweep index: 30; risk: low; payoff: 4/10
- LOC: About −47 to −67 net.
- github-template.ts: 206 → 134 in the parallel draft, or about 153 in the heavy estimate.
- git-wire.ts: about +5 to +6.
- github-template.test.ts: about ±10 (call shape, two messages). (skeptic measured: Measured with `git diff --no-index --numstat` against the applied scratch copies (formatted with oxfmt; tests green, tsc clean):
- `github-template.ts`: 206 → 137 lines (+25 −94, net −69).
- `git-wire.ts`: 910 → 915 lines (+14 −9, net +5; this includes making the three helpers private and fixing the stale `github.ts uses` comment).
- `github-template.test.ts`: 251 → 243 lines (+8 −16, net −8; `decodeRequestBody` is deleted). Deleting the two error rows instead saves about 26 more lines.

Total: net −72 lines (47 added, 119 deleted). That is slightly more than the candidate's estimate of −47 to −67.)

- Concepts: 2 git HTTP clients become 1. Today there are two header sets, two capped readers, two ls-refs paths, and only one of them retries.

### Evidence

Merges the parallel and heavy hunts.

- apps/os/src/repo/git-wire.ts:1-12 claims to be 'the one git protocol implementation'.
- repo/github-template.ts:144-206 has its own `fetchGithubObjects` and `fetchGithub`: v2 headers, a POST, a capped chunk reader with a manual concat (178-205) and a 15 s timeout. The reader and concat repeat git-wire.ts:760-777 `readCapped`+`concat`.
- github-template.ts:120-134 has its own ls-refs.
- git-wire.ts:842-910 `createGitWireTransport` already does all of this and retries an upstream 5xx once. Its `fetchObjects` is missing only the `filter` and limits parameters, and `encodeFetchRequest` already supports those.
- git-wire exports `demuxFetchResponse`, `encodeLsRefsRequest` and `parseLsRefs` only so this copy can use them. git-wire.ts:136 even says 'github.ts uses'.

### Current shape

Creating a project from a GitHub template builds v2 bodies by hand, POSTs them to GitHub, and reads the answer with its own capped loop. It has no retry. The repo facet does the same protocol through createGitWireTransport.

### Proposed shape

```ts
// git-wire.ts createGitWireTransport
fetchObjects: async (request: { deepen?: number; filter?: 'blob:none'; wants: string[] }, limits = DEFAULT_LIMITS) =>
  parsePack(demuxFetchResponse(await post('git-upload-pack', encodeFetchRequest(request))), limits),
refs: async (prefixes: string[]) => parseLsRefs(await post('git-upload-pack', encodeLsRefsRequest(prefixes))),
// github-template.ts
const githubRemote = (ref, githubFetch = (r: Request) => fetch(r)) => createGitWireTransport({
  remote: `https://github.com/${enc(ref.owner)}/${enc(ref.repo)}.git`, authorization: null,
  fetch: (request) => githubFetch(new Request(request, { signal: AbortSignal.timeout(15_000) })) });
```

Delete `fetchGithub`, `fetchGithubObjects` and `MAX_GITHUB_RESPONSE_BYTES`. The four protocol helpers become private to git-wire again.

### What changes

- A GitHub 5xx or dropped connection is retried once after 1 s (UPSTREAM_ONCE) and logged `repo.platform-failure-retry`. Today it fails the creation.
- The raw response cap goes from 12 MiB to 16 MiB. The inflated limits (2 MiB per file, 10 MiB total) are unchanged.
- Error text becomes the transport's, unless it is wrapped with a 'GitHub:' prefix.
- The User-Agent changes.
- Test mocks receive a Request.

### Pinned by

- src/repo/github-template.test.ts, all rows. :7-26 read `calls[0][1].body`; :171-195 pin the 429 and interrupted messages.
- git-wire.test.ts:41-146
- The call sites session.ts:1075 and project/durable-object.ts:71.

### Skeptic's amended proposal

Change `git-wire.ts` `createGitWireTransport` so `fetchObjects` takes the fetch options and limits, and add a `refs` verb. `tipOf` can then use `refs`:

```ts
const refs = async (prefixes: string[]) =>
  parseLsRefs(await post("git-upload-pack", encodeLsRefsRequest(prefixes)));
return {
  fetchObjects: async (
    request: { deepen?: number; filter?: "blob:none"; wants: string[] },
    limits = { maxObjectBytes: MAX_INFLATED_BYTES, maxTotalObjectBytes: MAX_INFLATED_BYTES },
  ): Promise<RawGitObject[]> =>
    parsePack(demuxFetchResponse(await post("git-upload-pack", encodeFetchRequest(request))), limits),
  refs,
  tipOf: async (ref: string) => (await refs([ref])).find((entry) => entry.name === ref)?.oid,
  ...
```

Make `demuxFetchResponse`, `encodeLsRefsRequest` and `parseLsRefs` non-exported. Fix the stale comment at git-wire.ts:136 to say `github-template.ts`.

In `github-template.ts`:

```ts
type GithubFetch = (request: Request) => Promise<Response>;
/** The template's repository, anonymously, each request given 15 s. */
function githubRemote(reference: ConfigRepoTemplateReference, githubFetch: GithubFetch) {
  return createGitWireTransport({
    remote: `https://github.com/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}.git`,
    authorization: null,
    fetch: (request) => githubFetch(new Request(request, { signal: AbortSignal.timeout(15_000) })),
  });
}
// pin:      ref: await resolveGithubRef(githubRemote(reference, githubFetch), requestedRef)
// download: const github = githubRemote(reference, githubFetch);
//           github.fetchObjects({ deepen: 1, filter: "blob:none", wants: [commitOid] }, {10 MiB, 10 MiB})
//           github.fetchObjects({ wants: [...oids] }, { maxObjectBytes: MAX_FILE_BYTES, maxTotalObjectBytes: MAX_TEMPLATE_BYTES })
// resolveGithubRef(github, requestedRef): const refs = await github.refs(prefixes); …unchanged
```

The default `githubFetch` becomes `(request) => fetch(request)`. Delete `fetchGithub`, `fetchGithubObjects` and `MAX_GITHUB_RESPONSE_BYTES`.

In `github-template.test.ts`:

- Read `calls[0][0]` as a Request: use `.url`, `.headers.has("authorization")` and `await .text()`, and delete `decodeRequestBody`.
- In the error table, either update the two messages ("git-upload-pack responded 429 for https://github.com/iterate/failing.git" and "connection closed") or drop the table. git-wire.test.ts:41-146 already pins the 4xx, 5xx and retry behaviour, and the interrupted-body row now waits out one retry (about 0.8 s).

Don't wrap errors with a "GitHub:" prefix. That would put back a try/catch layer, and the transport's message already names github.com and quotes GitHub's reason.

### Skeptic's verdict

The claim holds. I applied the change to scratch copies of the three files, then ran the unit tests and tsc.

**Is it really a duplicate?** Yes. github-template.ts:144-206 is a second git smart-HTTP client, and it has drifted from `createGitWireTransport` (git-wire.ts:842-910):

- The transport retries once; the template client doesn't.
- The raw cap is 16 MiB in one and 12 MiB in the other.
- The headers and User-Agent differ.
- The template client has its own capped reader and concat (github-template.ts:180-205), which repeat `readCapped`/`concat` in git-wire.
- It sends its own ls-refs.

git-wire exports `demuxFetchResponse`, `encodeLsRefsRequest` and `parseLsRefs` only for this copy; `git grep` finds no other user. The transport already talks to GitHub: a repo's origin is reached through it via `gitRemoteOf` plus egress, with no Accept header. So GitHub is known to accept its headers. `encodeFetchRequest` already takes `deepen?` and `filter?`.

**What changes (the "almost"):**

1. **Retry.** A GitHub 5xx, a failed connection, or a body cut mid-stream (a TypeError from `reader.read`) is sent once more after 0.5 to 1 s. Each retry logs a `repo.platform-failure-retry` warn, and a final failure logs `-gave-up`. A 429 isn't repeated, but it now logs `repo.platform-failure-gave-up`. The prd fault alarm pages only on a burst of these, so single lines won't page.
2. **Error text.** Users see these messages when creating a project (the pin in session.ts:1075, or a failed seed saga):
   - "GitHub returned HTTP 429 while reading the config template." becomes "git-upload-pack responded 429 for https://github.com/o/r.git", plus up to 200 characters of GitHub's own words.
   - "GitHub could not be reached." and "GitHub interrupted…" become the raw TypeError or timeout message.
   - The over-size message becomes "the remote answered more than 16777216 bytes".
3. **Raw cap.** It goes from 12 MiB to 16 MiB. The inflated limits (2 MiB per file, 10 MiB in total) are unchanged.
4. **Headers.** The User-Agent becomes "(iterate-repos)" and the Accept header is dropped.
5. **Injected fetch.** It becomes `(request: Request) => Promise<Response>`. Only tests inject one; project/durable-object.ts:71 and session.ts:1075 use the default.
6. **Worst case per call.** Two attempts instead of one, and 15 s per attempt still. An abort from the timeout is "failed", so it is never retried.

**No guarantee is dropped.**

- No credential is sent: with `authorization: null` the transport sends no header, and the test still asserts it.
- The raw response is still capped, and the inflated limits still apply.
- The 15 s timeout stays, applied per request in the wrapper.
- The retry is bounded and only for reads.

**Simpler?** Yes, genuinely: two git HTTP clients become one. Three protocol helpers become private again. The only new API is `refs(prefixes)` next to `tipOf` and an optional `limits` argument.

**Verification.** I re-ran the unchanged tests against the new code. They failed exactly where expected: the three rows that read `calls[0][1]` and the two message rows (github-template.test.ts:7-26, 54-58, 85-87, 171-195). After updating them, all 62 rows of git-wire.test and github-template.test pass, and tsc exits 0. The "interrupted body" row now takes about 0.8 s because of the retry. Drop that row or fake the timers; git-wire.test.ts:41-146 already pins the retry policy.

**Risk:** low, on a peripheral path (creating a project from a GitHub template).

## A personal access token's end is recorded once, in endedGrants, instead of also copied into an endedAt nothing reads

- Sweep index: 31; risk: low; payoff: 3/10
- LOC: About −18 in total.
- processor.ts: 89 → 77.
- contract.ts: −1.
- Tests: processor.test.ts rows get shorter; oauth.test.ts:118 −1; personal-access-tokens.test.ts:71 −1; :206-208 is retargeted. (skeptic measured: I applied the change to scratch copies and ran oxfmt with the repo's .oxfmtrc.json (printWidth 100). It removes 17 lines:
- src/account/processor.ts: 89 → 80 (−9). The candidate's "77" is wrong.
- src/account/contract.ts: 201 → 198 (−3). Removing the field lets `.extend({ mintedAt: z.string() })` collapse onto one line. The count includes the version bump from 9 to 10.
- src/account/processor.test.ts: 318 → 317 (−1). The `key` helper loses its endedAt parameter and field.
- **workers-tests**/personal-access-tokens.test.ts: 587 → 584 (−3). Line 71 goes, and the assertion at :206-208 becomes the one line `expect((await accountStateOf(env, user.id)).endedGrants[id]).toEqual({ at: expect.any(String) });`.
- src/oauth.test.ts: 156 → 155 (−1).)
- Concepts: 2 records of one end, plus the 'born closed' ordering rule, become 1 record.

### Evidence

- apps/os/src/account/contract.ts:117-128: the key record carries `endedAt` right beside `endedGrants`, which the contract calls 'THE REVOCATION TRUTH'.
- processor.ts:29-56 keeps the two in step. The mint copies `endedGrants[id]?.at` into `endedAt`, and `grant-ended` patches both.
- Every reader uses endedGrants: oauth.ts:487, :540 and grants.ts:127, :152, :193.
- `rg endedAt` outside the contract and the processor finds only three test files.

### Current shape

Two records hold the fact that a key ended. They are kept in step by an ordering special case: an end that lands before the mint gives the key a record that is 'born closed'.

### Proposed shape

```ts
case '…/personal-access-token-minted': { const { id, ...key } = event.payload; if (state.personalAccessTokens[id]) return undefined;
  return { ...state, personalAccessTokens: { ...state.personalAccessTokens, [id]: { ...key, mintedAt: event.createdAt } } }; }
case '…/grant-ended': { const { grantId } = event.payload; if (state.endedGrants[grantId]) return undefined;
  return { ...state, endedGrants: { ...state.endedGrants, [grantId]: { at: event.createdAt } } }; }
```

Drop `endedAt` from the contract and bump the account contract from 9 to 10.

### What changes

- The account state loses `personalAccessTokens[id].endedAt`.
- The version bump re-reduces every account log.
- Admission, listing and revocation do not change.

### Pinned by

- src/account/processor.test.ts:74-130
- **workers-tests**/personal-access-tokens.test.ts:71 and :206-208
- src/oauth.test.ts:118

### Skeptic's amended proposal

In apps/os/src/account/processor.ts:

- The `personal-access-token-minted` case drops the comment and `const endedAt` at :32-33 and writes `[id]: { ...key, mintedAt: event.createdAt }`.
- The `grant-ended` case drops `const token` at :45 and the `...(token && {...})` spread at :49-54. It returns `{ ...state, endedGrants: { ...state.endedGrants, [grantId]: { at: event.createdAt } } }`.

In apps/os/src/account/contract.ts:

- Remove `endedAt` from the `personalAccessTokens` record schema, which formats to `PersonalAccessTokenMinted.omit({ id: true }).extend({ mintedAt: z.string() })`.
- Reword the doc comment at :115-116 to say a key's end lives in `endedGrants`.
- Bump the version from 9 to 10. The bump is optional, since the stale field is harmless, but it is preferred. Check first that no other open PR bumps the account contract.

In the tests:

- processor.test.ts: the `key(name, expiresAt)` helper drops its endedAt parameter and field. Reword the row name and the "born closed" comment at :94 to say that an end before the mint is recorded in `endedGrants`, where admission reads it.
- personal-access-tokens.test.ts: drop `endedAt: null` at :71. Retarget :206-208 to `expect((await accountStateOf(env, user.id)).endedGrants[id]).toEqual({ at: expect.any(String) })`.
- oauth.test.ts: drop `endedAt: null` at :118.

The measured delta is −17 LOC: processor −9, contract −3, tests −5.

### Skeptic's verdict

(a) The semantics claim holds. I ran `rg endedAt` over the whole repo, excluding apps/agents, whose `endedAtMs` is unrelated. Only four places carry this field: the contract, the processor, and three test fixtures or assertions. No code reads it:

- Admission reads `account.endedGrants[named.id]` (oauth.ts:487), and so does the grant check at oauth.ts:171 and :540.
- The list in grants.ts:127 and :152 hides a key when `endedGrants[id]` is set. `grants.end` at :193 also reads `endedGrants`.
- No client, spec or package reads `personalAccessTokens[*].endedAt`. The dash and `iterate tokens list` go through grants.list, which already drops ended keys.

So the only observable change is that the account's live state loses one unread field. The live state still updates when a key ends, because `endedGrants` changes.

The "born closed" rule (processor.ts:32-33) exists only to keep the copy in step when an end lands before its mint. With `endedGrants` as the only record, the order stops mattering, because every reader checks `endedGrants[id]` whenever it runs.

(b) The new shape is really simpler, not just different. `grant-ended` no longer reads or writes a second map (the `token &&` spread at :45 and :49-54). The mint no longer reads `endedGrants`. The two maps stop being coupled, and one ordering special case disappears. The fold goes from two records of one fact plus a sync rule to one record.

(c) No guarantee is lost. `endedGrants` was already the revocation truth the contract names, and every admission path reads it. The idempotence of "minted once" and "ended once" is unchanged.

(d) The candidate's LOC numbers were a little off; the measured total is −17 (see locMeasured). Tests that pin the current behaviour are processor.test.ts:32-41 (the `key` helper), :74-130 and :228; personal-access-tokens.test.ts:71 and :206-208; and oauth.test.ts:118. All of them change mechanically. The row name and the "born closed" comment at :94 need rewording: the key record exists and its end sits in `endedGrants`.

Two small corrections to the proposal:

- The version bump is optional. Without it, old checkpoints keep a stale, unread `endedAt`, which is harmless. With it, every account log re-reduces on its next wake. Under the no-cruft taste the bump is the right call, but check that no other open PR bumps the account contract to 10, because processor version bumps collide silently.
- The contract's doc comment at :115-116 should say that a key's end is recorded in `endedGrants`.

It is small and not central, but it is a real case of two records holding one fact, kept in step by a rule that has to be explained. It is not a style nit.

## A workspace mount is the repo's own path: drop the identity mount→repo table and the duplicate `repo` field in three answers

- Sweep index: 32; risk: low; payoff: 3/10
- LOC: About −13 to −20 net.
- workspace/durable-object.ts: 334 → about 313–325.
- api.ts: 3 type lines changed.
- e2e: about −3. (skeptic measured: Measured on formatted draft copies in the scratchpad:
- apps/os/src/workspace/durable-object.ts: 336 → 323 (+35/−48).
- apps/os/e2e/workspaces.e2e.test.ts: 439 → 437 (+3/−5).
- packages/iterate/src/api.ts: 1276 → 1276 (+4/−4).
- Net: −15 lines.)
- Concepts: 2 names for one thing become 1.

### Evidence

Merges the parallel and heavy hunts.

The identity mapping is visible throughout apps/os/src/workspace/durable-object.ts:

- :32-33 declares `type WorkspaceMount = { repo: string }`.
- :139-146 `mounts()` always writes `mounts[path] = { repo: path }`, and it is the only producer.
- :55-66 `routeMount` returns both `mountPath` and `repo`.
- :38-39 `WorkspaceMountStatus` is `{ path, repo }`.
- :269-316 gitCommit returns `{ mount, repo }`.
- :319-333 gitLog reads `mounts[scope].repo`.

The pair is also:

- published in packages/iterate/src/api.ts:613, :617 and :635;
- pinned by e2e/workspaces.e2e.test.ts:40.

Nothing else reads `.repo`. apps/notes uses only readFile, writeFile and gitCommit({ scope }).

### Current shape

The workspace keeps a table from mount path to `{ repo }` whose key and value are always equal. Its answers report `path` and `repo`, or `mount` and `repo`, and those are always the same string.

### Proposed shape

```ts
async mounts(): Promise<string[]> { await this.#created(); return (await this.withItx((itx) => itx.repos.list())).map(({ path }) => path); }
function routeMount(mounts: string[], path: string): { mount: string; relativePath: string } | null
// gitStatus → { mounts: { path, changes }[], unmounted }; gitCommit → { commitOid, mount, changedPaths }; gitLog: mounts.includes(scope)
```

### What changes

Only the public shape changes:

- `mounts()` answers `string[]` instead of a record.
- `gitStatus().mounts[i].repo` and `gitCommit().repo` are removed.

Routing, whiteouts, commits and refusals are unchanged.

This is an SDK API change, which docs/jonasland-rules.md says to confirm with a human first.

### Pinned by

- e2e/workspaces.e2e.test.ts:40, 55, 59, 86-92, 184, 261, 318, 366
- e2e/context-residency.e2e.test.ts:560

### Skeptic's amended proposal

Drop the identity table. A mount is the repo's own path.

**durable-object.ts**

- Delete `type WorkspaceMount`.
- `WorkspaceMountStatus` becomes `{ path: string; changes: WorkspaceChange[] }`.
- `routeMount` becomes `routeMount(mounts: string[], path): { mount: string; relativePath: string } | null`, with the same longest-proper-prefix loop over `mounts`.
- `mounts()` becomes:
  ```ts
  async mounts(): Promise<string[]> {
    await this.#created();
    using itx = this.getItx();
    return (await itx.repos.list()).map(({ path }) => path);
  }
  ```
- `writeFile` uses `(await this.mounts()).includes(resolved)`.
- `#readMounted`, `deleteFile` and `#status` call `itx.repos.get(route.mount)`.
- `listAllFiles` does `mounts.map(async (mount) => …itx.repos.get(mount)…routeMount(mounts, path)?.mount === mount)`.
- `#status` builds `byMount` from `mounts.map((path) => [path, { path, changes: [] }])`.
- `gitCommit` calls `itx.repos.get(mountPath)` and returns `{ commitOid, mount, changedPaths }`.
- `gitLog` becomes:
  ```ts
  const scope = input.scope ? absolutePath(input.scope) : mounts.length === 1 ? mounts[0]! : "";
  if (!mounts.includes(scope)) throw …;
  itx.repos.get(scope).log(…)
  ```

**api.ts**

- `WorkspaceMountStatus` loses `repo`.
- `mounts()` returns `Promise<string[]>`.
- `gitCommit` returns `{ commitOid; mount; changedPaths }`.

**e2e**

- `workspaces.e2e.test.ts:40` expects `["/repos/config"]`.
- Remove `repo` at :58, :87, :92 and :319.

This is an SDK shape change, so Jonas must confirm it (docs/jonasland-rules.md).

### Skeptic's verdict

The claim is true, though the payoff is small.

**Why the table is always an identity.**

- `mounts()` at apps/os/src/workspace/durable-object.ts:139-146 is the only place the table is built, and it always writes `mounts[path] = { repo: path }`.
- It has been an identity table since it first appeared in #2650 (90a10ca71). No version ever mapped a mount to a different repo.
- `itx.repos.list()` (apps/os/src/project/collection.ts:111) is `Object.entries` over a catalog keyed by path. So the paths are unique, and an array keeps the same order as the record's keys.
- Every key starts with `/`, so neither `in` nor `mounts[scope]` can hit an `Object.prototype` name. Replacing them with `.includes` changes nothing.

**(a) What actually changes.** Only the public answer shapes:

- `mounts()` returns `string[]` instead of `Record<string, { repo }>`.
- `gitStatus().mounts[i].repo` is removed.
- `gitCommit().repo` is removed.

Routing, longest-prefix matching, whiteouts, the directory refusal, commit scope rules, gitLog refusals and error text are all unchanged.

Consumers of the removed fields: none in production code.

- apps/notes reads only `committed.changedPaths` and `commitOid`.
- `itx-expression-rewriting.ts:99` only names `writeFile` and `gitCommit`.
- No package or spec calls `mounts()`, `gitStatus` or `gitLog`.

Because this changes a published SDK type in packages/iterate/src/api.ts:613, :617 and :635, docs/jonasland-rules.md requires Jonas's sign-off. Any user code in a config repo that reads `.repo` would break. That is acceptable under his no-backcompat rule, but it is still an API shape change.

**(b) Is it really simpler?** Yes, not just different.

- The `WorkspaceMount` type goes.
- `routeMount` returns `{ mount, relativePath }` instead of `{ mountPath, repo, relativePath }`, whose two strings were always the same.
- Three answer shapes lose a duplicated field.
- gitLog's `mountPaths` and `Object.keys` step goes.

Concepts go from 2 (mount path and repo path, which a reader must check are equal) to 1. The `{ "/repos/config": { repo: "/repos/config" } }` answer is exactly the "hard to explain" smell.

**(c) Guarantees.** Nothing is dropped. There are no security, loop, delivery or data paths here.

**(d) LOC.** I drafted the change on copies in the scratchpad (not in wt-main) and ran oxfmt with the repo's config.

- durable-object.ts: 336 → 323 (numstat +35/−48).
- workspaces.e2e.test.ts: 439 → 437 (+3/−5).
- api.ts: 1276 → 1276 (4 lines changed).
- Net: −15 lines across 3 files.

That is below the candidate's upper estimate of −20.

**Corrections to the candidate.**

- Its sketch uses `this.withItx(...)`. Since #3442 the file uses `using itx = this.getItx()`, so `mounts()` becomes `await this.#created(); using itx = this.getItx(); return (await itx.repos.list()).map(({ path }) => path);`.
- Its pin list is too wide. Only these pins change:
  - workspaces.e2e.test.ts:40 (`mounts` toEqual);
  - :58 (`repo` in the gitStatus toEqual);
  - :87 (`repo` in the commit toMatchObject);
  - :92 and :319 (`repo` in the gitStatus toEqual).
- These lines do not depend on the shape: :184 (maps `m.path` only), :261 (call arguments), :366 (a rejection) and context-residency.e2e.test.ts:557, which only matches a `/deleted/` rejection (the candidate said :560).

**Verdict.** This is real residue of a mount table that was never configurable, and the change is mechanical and safe. But it is a small cleanup, about 15 lines in one file, not heavy junk. It is best done as part of other workspace work, after Jonas has approved the SDK shape change.

## Adding a custom hostname finds the DNS zone once, then asks Domain Connect only there

- Sweep index: 33; risk: medium; payoff: 4/10
- LOC: About −35 product lines.
- domain-connect.ts: 188 → 159 (drafted).
- Shared DoH helper: about −8 more.
- processor.ts: +1.
- Tests: the ladder rows move, and 3 rows are rewritten to pass a zone. (skeptic measured: I drafted the change in scratchpad/dc-draft and formatted it with the repo's oxfmt.

Product code:

- domain-connect.ts: 188 → 151 (−37).
- dns-provider.ts: 100 → 106 (+6), because it gains the shared `dohAnswer`.
- processor.ts #addHostname: `Promise.all` goes from 4 lines to 3 (−1).
- durable-object.ts: ±0.
- Net: about −32 product lines.

Tests: domain-connect.test.ts goes about 259 → ~220, roughly −40:

- the zones table (lines 12-34) goes;
- the decoy test (139-148) and the decoy branch in the fake go;
- the walk test's asked list loses 2 lines.

dns-provider.test.ts and processor.test.ts are unchanged.)

- Concepts: Before: 2 zone ladders, 2 DoH readers and 2 status checks.
  After: 1 of each.

### Evidence

- apps/os/src/project/processor.ts:705-708: `#addHostname` runs `hostnames.connect(hostname)` and `hostnames.dnsZone(hostname)` side by side.
- project/dns-provider.ts:73-99 `dnsZoneOf` walks up from the hostname with NS lookups over DNS-over-HTTPS (DoH), via `domainConnectZonesOf`.
- project/domain-connect.ts:120-188 `domainConnectLinkOf` walks the same list with `_domainconnect` TXT lookups, using five `continue`s.
- There are two DoH schemas: dns-provider.ts:41-44 and domain-connect.ts:47-50.
- There are two copies of the Status 0/3 check: dns-provider.ts:87-88 and domain-connect.ts:154-155.

### Current shape

Each add finds the owner's zone twice:

- by nameservers, for the dash's instructions;
- by probing `_domainconnect` TXT at every ancestor, for the one-click link.

Each walk has its own DoH request and parser.

### Proposed shape

```ts
// processor #addHostname
const dns = await bestEffort('dns zone', () => hostnames.dnsZone(hostname));
const connect = dns && (await bestEffort('domain connect', () => hostnames.connect(hostname, dns.zone)));
// domain-connect.ts
export async function domainConnectLinkOf(hostname: string, zone: string, options) {
  const host = hostname === zone ? '' : hostname.slice(0, -(zone.length + 1));
  const txt = (await dohAnswer(`_domainconnect.${zone}`, 'TXT', fetcher)).find((r) => r.type === 16);
  …
}
```

One `dohAnswer(name, type, fetcher)` replaces the two schemas and the two status checks.

### What changes

- Domain Connect is asked only at the zone the nameservers name, which is where the spec puts `_domainconnect`. A stray TXT at a non-zone ancestor is no longer followed.
- The two lookups now run one after the other. In the worst case this adds the NS walk (each request ≤5 s) to a best-effort step.
- A hostname whose zone the NS walk cannot find now gets no link.
- DoH requests per add drop from about 2×depth to depth+1.

### Pinned by

- src/project/domain-connect.test.ts:12-35, :80, :139 and :192
- dns-provider.test.ts:40, :65 and :74
- processor.test.ts:680, :714, :793 and :843

### Skeptic's amended proposal

Find the zone once with the NS walk, then ask Domain Connect only at that zone. This is what the spec requires ("Discovery must work on the root domain (zone) only").

**1. dns-provider.ts owns the walk and the one DoH reader**

```ts
export async function dohAnswer(name: string, type: "NS" | "TXT", fetcher: typeof fetch) {
  const response = await fetcher(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
    { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5_000) },
  );
  const dns = DohAnswer.parse(await response.json());
  if (dns.Status !== 0 && dns.Status !== 3)
    throw new Error(`DNS status ${dns.Status} for ${name} ${type}`);
  return dns.Answer || [];
}
// in dnsZoneOf:
const labels = hostname.split(".");
const zones = labels.slice(0, -1).map((_, i) => labels.slice(i).join("."));
```

Delete `domainConnectZonesOf` and its test table.

**2. domain-connect.ts becomes straight-line**

```ts
export async function domainConnectLinkOf(hostname: string, domain: string, options) {
  const host = hostname === domain ? "" : hostname.slice(0, -domain.length - 1);
  const txt = (await dohAnswer(`_domainconnect.${domain}`, "TXT", fetcher)).find(
    (r) => r.type === 16,
  );
  const settingsUrl =
    txt && HttpsUrl.safeParse(`https://${txtRecordText(txt.data).trim()}/v2/${domain}/settings`);
  if (!settingsUrl?.success) return null;
  // settings → template → signedApplyUrl as today, each `continue` now `return null`
}
```

Also delete `DohTxtAnswer`, the loop and the `headers` parameter of `request`.

**3. processor.ts #addHostname**

```ts
const dns = await bestEffort("dns zone", () => hostnames.dnsZone(hostname));
const connect =
  dns && (await bestEffort("domain connect", () => hostnames.connect(hostname, dns.zone)));
```

`ProjectHostnames.connect` becomes `(hostname, zone)`, and durable-object.ts passes the zone through.

**4. apps/dash domains.tsx:483**

`zone || hostname` becomes `zone`, since a link now always has its zone.

**Semantics delta**

- A delegated sub-zone under a Domain Connect parent no longer gets a link that writes into the parent below the delegation. Today's behaviour there is a bug.
- A wildcard-synthesized `_domainconnect.<hostname>` is no longer probed.
- One DoH round trip is added, sequentially.
- No NS zone means no link.

**Tests**

- Drop the zones table and the decoy test.
- Pass a zone in the domain-connect rows.
- Add `name` to the TXT fakes.
- The redirect test asserts `manual` only on provider requests.
- dns-provider.test.ts and processor.test.ts are unchanged.

**Size and risk**

- About −32 product lines and about −40 test lines.
- Concepts: two zone ladders, two DoH readers and a fallback policy become one ladder, one reader and no fallback.
- Risk: low-medium. Prove it live against real Cloudflare and GoDaddy zones.

### Skeptic's verdict

The claim holds, and the delta is better than the candidate says.

**(a) What changes**

- **Zone choice.** The Domain Connect spec says discovery "must work on the root domain (zone) only", and settings takes "the registered domain or delegated zone". The NS walk finds exactly that zone cut. The TXT walk visits the same ancestor list, so in the common case both pick the same zone.
- **Where they differ, the new shape is right and the old one is wrong:**
  - Delegated subdomain. Take `shop.example.com` delegated to Route53 under a GoDaddy `example.com`. Today the TXT walk falls through to `example.com` and returns a GoDaddy link that writes `iterate.shop` into the parent zone, below a delegation, where the records can never resolve. The dash then prints "shop.example.com's DNS is on GoDaddy" (domains.tsx:483 mixes `dns.zone` with `connect.provider`).
  - Wildcards. The first probe today is `_domainconnect.<hostname>`, which a wildcard `*.zone` TXT or CNAME answers (and `.find(type===16)` does not filter by name). The junk TXT then becomes a settings URL: it is either skipped, or fetched against an unresolvable host, where `request` throws and the whole best-effort link is lost.
- **Timing.** The two lookups become sequential. That adds about one DoH round trip, bounded at 5 s per request, to a best-effort step that is never on the serving path.
- **No zone, no link.** A hostname whose NS walk returns null or throws now gets no link. That only happens for an unregistered name or a DNS failure, where Domain Connect would fail too.
- **Tests that must change:**
  - domain-connect.test.ts: the zones table (:12) goes; the walk test (:80) asserts one TXT query; the decoy test (:139) is deleted as intended.
  - The TXT fakes need a `name` field.
  - The redirect test (:173) must filter to provider requests, because the DoH request no longer carries `redirect:"manual"`. That is harmless: the DoH URL is fixed to cloudflare-dns.com.
  - processor.test.ts fakes (`connect: async (name) =>`) still typecheck, and their outcomes are unchanged. The :718 row still yields both values.

**(b) Simpler or just different**

It is genuinely simpler:

- One ancestor walk instead of two. Today dns-provider.ts imports a Domain Connect helper, `domainConnectZonesOf`, only to throw away its `host`.
- One DoH reader and status check instead of two.
- Domain Connect becomes straight-line (TXT → settings → template → link). This removes the loop, the five `continue`s, the "try the next zone up" policy, and the decoy fixture that tests it.
- The exported `domainConnectZonesOf` and its 3-row table disappear.
- The one conceptual cost is honest: `connect` now depends on `dns`, which is the true relationship.

**(c) Guarantees**

No real guarantee is dropped:

- https-only URLs, `redirect:"manual"` on provider requests, 5 s bounds, throw-on-SERVFAIL and the best-effort logging all stay.
- The country-registry stop now protects Domain Connect too.
- It also cuts outbound fetches to hosts that DNS named at non-zone names.

**(d) LOC**

Re-measured at about −32 product and about −40 test lines. The candidate's "about −35" was close.

**Amendments to the proposal**

- `dohAnswer` belongs in dns-provider.ts, which reverses today's import direction.
- Delete `domainConnectZonesOf`.
- Optionally filter the TXT by `record.name`.
- The dash's `zone || hostname` (domains.tsx:483) can become `zone`.
- Before merging, check live against a real Cloudflare zone and a GoDaddy zone, as #3370 did.

## MCP and capnweb library connections each hold one session slot, instead of generation counters, closed flags and handshake memos

- Sweep index: 35; risk: medium; payoff: 4/10
- LOC: About −57 net, drafted.
- mcp.ts: 296 → about 252.
- capnweb.ts: 172 → about 163.
- library.test.ts: −4. (skeptic measured: Measured on a scratch copy with git diff --numstat: mcp.ts 296 → 274 (−22), capnweb.ts 172 → 164 (−8), library.test.ts ±0 (two rows restructured). Net −30 lines, not the claimed −57.)
- Concepts: 7 fields become 2 session slots.

### Evidence

- apps/os/src/library/mcp.ts:122-254. McpJsonRpcClient keeps four fields for one session: #sessionId, #closed, #handshake and #generation (:130-138).
- It has three moving parts:
  - initialize() with a current-memo guard (:147-161)
  - #runHandshake (:162-190)
  - close(), which bumps the generation (:214-222)
- About 32 of those 135 lines are comments explaining races.
- capnweb.ts:33-76 builds the same thing again from `session`, `reopening` and `generation` (:38-43 and :53-66).
- Both exist because library.ts:181-199 `releaseConnections` closes memoized connections while a holder may still use them.

### Current shape

A connection closed by the pins' release reopens on its next call. To keep a reopen that races a close from reviving the client or leaking a session, each connector carries three things that every step compares:

- a generation counter
- an in-flight field
- a live field

### Proposed shape

```ts
// mcp.ts
#session: Promise<{ id: string | null; serverInfo: MCPServerInfo }> | null = null;
session() {
  if (!this.#session) { const opening = this.#handshake(); this.#session = opening; opening.catch(() => { if (this.#session === opening) this.#session = null; }); }
  return this.#session;
}
async close() { const closing = this.#session; this.#session = null; const open = await closing?.catch(() => null); if (open && open.id !== null) await this.#deleteSession(open.id); }
// capnweb.ts: let session: SessionStub | Promise<SessionStub> | undefined; identity check replaces the counter
```

### What changes

MCP:

- A call whose re-handshake was in flight when close() ran now posts on that session, and close then DELETEs it. Today the call fails with 'MCP client was closed during its handshake'.
- close() waits for an in-flight handshake before its DELETE.
- The guarantees stay: no session leaks, a stale handshake never touches its replacement, and a closed client re-handshakes once.

capnweb: no change.

### Pinned by

- src/library.test.ts:67, :83, :105 (expectation changes), :133, :692 (message changes), :741, :751 and :764
- e2e/library-connectors.e2e.test.ts:67

### Skeptic's amended proposal

MCP (mcp.ts:122-254), as drafted and tested:

```ts
type McpSession = { id: string | null; serverInfo: MCPServerInfo };
#session: Promise<McpSession> | null = null;
session() {
  if (!this.#session) {
    const opening = this.#handshake();
    this.#session = opening;
    void opening.catch(() => { if (this.#session === opening) this.#session = null; });
  }
  return this.#session;
}
// #handshake: #send("initialize", …, null) → notify(initialized, id) → { id, serverInfo };
//   on a failure after allocation it DELETEs its own id, as today
async request(m, p) { const { id } = await this.session(); return (await this.#send(m, p, id)).result; }
async close() {
  const closing = this.#session; this.#session = null;
  const closed = await closing?.catch(() => null);
  if (closed && closed.id !== null) await this.#deleteSession(closed.id);
}
```

`#send` takes `sessionId` explicitly, with no default. `connectToMcp` does `const { serverInfo } = await client.session()`.

capnweb (capnweb.ts:37-76):

```ts
let session: SessionStub | Promise<SessionStub> | undefined;
const open = () => {
  const opening = webSocketSessionOverEgress(itx, url, headers).then((stub: SessionStub) => {
    if (session !== opening) {
      dispose(stub);
      throw new Error("capnweb connection closed while it was reconnecting");
    }
    stub.onRpcBroken?.(() => {
      if (session === stub) session = undefined;
    });
    return (session = stub);
  });
  void opening.catch(() => {
    if (session === opening) session = undefined;
  });
  return (session = opening);
};
await open();
return new CapnwebConnection(
  () => session ?? open(),
  () => {
    const gone = session;
    session = undefined;
    if (gone && !(gone instanceof Promise)) dispose(gone);
  },
);
```

Tests:

- In library.test.ts:108 and :694, start `conn.close()` without awaiting it, release the parked handshake, then await the close. As written, they deadlock.
- Drop the two `/closed during its handshake/` assertions.
- Update the stale "generation" comments at :716-720.

Semantics:

- An MCP call parked on a handshake that a close overtakes now posts on the doomed session and races its DELETE. A real server may run the tool or answer 404. Today the call fails before posting.
- `close()` awaits an in-flight handshake. The platform `void`s it.
- capnweb: a call after such a close now opens fresh instead of joining the stale reopen. This fixes a small existing bug.

### Skeptic's verdict

I drafted the change on a scratch copy of origin/main (b3daf4846) and it holds up. PR #3446 does not touch apps/os/src/library/*. The diff is at scratchpad/mcp-capnweb-session-slot.diff.

Results:

- All 83 rows of src/library.test.ts pass after two race rows are restructured.
- `tsc` passes on tsconfig.json and tsconfig.tests.json.
- oxlint with --deny-warnings is clean.

**(b) Really simpler, not just different.**

- MCP state goes from `#sessionId`, `#closed`, `#handshake` and `#generation` plus the memo guard in `initialize()` to one `#session: Promise<{id, serverInfo}> | null` slot. `close()` takes the slot, awaits it and DELETEs what it resolved to.
- `#send` loses its hidden default parameter, which read the live `#sessionId`. Most of the comment wall about races goes with it.
- capnweb goes from `session`, `reopening` and `generation` to one `session: Stub | Promise<Stub>` slot plus an identity check.
- This is the same pattern `library.ts` `memoized` already uses one layer up: a stored promise, cleared on failure only if it is still the current one. So the pattern is not new to the codebase.

**(c) No real guarantee is dropped.** These rows still pass unchanged:

- one shared re-handshake with no session-less post (:86)
- a stale handshake DELETEs its own session and never the live replacement (:694)
- a failed discovery DELETEs the session (:743)
- close DELETEs exactly once (:753)
- a closed connection re-handshakes (:766)
- the capnweb local close (:136)
- a failed connect is not memoized (:167)

**(a) The semantics delta, amended.** The candidate's version was partly off.

1. **MCP call parked on a re-handshake that a close overtakes.** Today it fails before touching the server ("closed during its handshake"). Now it posts `tools/call` on that session while close's DELETE of the same session is in flight. A real server may run the tool or answer 404. In the fake, the DELETE even logged first. This is exactly what already happens today to a call that posted just before close, so the behaviour becomes uniform. Only the two library.test.ts rows assert the old message.
2. **`close()` now awaits an in-flight handshake.** Consequence: the rows at :108 and :694, which `await conn.close()` while the handshake is parked, deadlock as written and must start the close, release the handshake, then await. `releaseConnections` and `[Symbol.dispose]` `void` the close, so the platform never waits. A user's `await conn.close()` can wait as long as a slow initialize.
3. **capnweb is not "no change". It is a small fix.** Today `close` does not clear `reopening`, so a call made after a close that overtook a reopen joins the stale reopen and fails "closed while it was reconnecting". Now it opens fresh. Calls parked before the close still fail as today.

**(d) LOC re-measured with git diff --numstat:**

- mcp.ts: 296 → 274 (+45 / −67)
- capnweb.ts: 172 → 164 (+22 / −30)
- library.test.ts: ±0 (7 / 7)
- Net: −30. The candidate's −57 is about double.

Payoff is moderate. It is a leaf library that is not central, but it removes the generation concept from two places.

## The config publication uses retryPlatformFailures and withTimeout instead of a private, unjittered retry ladder with a hand-rolled race

- Sweep index: 36; risk: medium; payoff: 3/10
- LOC: processor.ts (787 lines): #publish goes from 73 to 52 lines in the draft, about −20 overall. processor.test.ts is unchanged. (skeptic measured: - apps/os/src/project/processor.ts: 793 → 784 (−9). `#publish` goes from 60 to 52 lines, the two constants (8 lines) become one (4 lines), and the imports grow by 4 net.
- packages/shared/src/platform-retry.ts: +3 for the named `PUBLICATION` schedule.
- Net about −6 lines.
- processor.test.ts: 0 lines changed; all 47 rows pass, and only :632's title would need rewording.
- Measured with `git diff --numstat` and `wc -l` on an oxfmt-formatted draft in a clone of wt-main at b3daf4846.)
- Concepts: A private retry mechanism (wait ladder, total budget, race timer, lastFailure) is replaced by the repo's shared schedule, retry and timeout helpers.

### Evidence

apps/os/src/project/processor.ts:

- :52-59 define PUBLICATION_BUDGET_MS and PUBLICATION_ATTEMPT_WAITS_MS = [0, 5_000, 30_000].
- :600-660 hold the retry loop: `giveUpAt`, a `new Promise(setTimeout)` sleep, a hand-built Promise.race against a budget timer with its own clearTimeout, and `lastFailure`.

The repo's shared helpers already cover this:

- packages/shared/src/platform-retry.ts:212-260 `retryPlatformFailures`
- packages/iterate/src/lib.ts:297-322 `withTimeout`

docs/engineering-invariants.md:66-72 says: 'Schedules come from one short list … each wait … is jittered, and giving up on an idempotent call is logged once'. This ladder is on no list, is not jittered, and never logs its give-up.

#3446 made the publication one batch; the loop itself is unchanged.

### Current shape

#publish runs up to three attempts at 0 s, 5 s and 30 s inside a 60 s total budget enforced by a hand-rolled race timer. When the retries are exhausted it appends `worker-update-failed { unavailable }`.

### Proposed shape

```ts
const PUBLICATION_RETRIES: Schedule = { delaysMs: [5_000, 30_000], repeatsOverload: true };
const PUBLICATION_ATTEMPT_MS = 20_000;
const publicationFailureKind = (e: unknown) =>
  errorCode(e) === "TIMEOUT" ? "overloaded" : failureKind(e);
try {
  attempt = await retryPlatformFailures(
    () =>
      withTimeout(
        this.#attemptPublication(commitOid, generation, publisher),
        PUBLICATION_ATTEMPT_MS,
        `publication ${generation}`,
      ),
    {
      area: "project",
      schedule: PUBLICATION_RETRIES,
      idempotent: true,
      kind: publicationFailureKind,
      describe: () => ({ commitOid, generation }),
    },
  );
} catch (error) {
  if (!isPlatformFailureKind(publicationFailureKind(error))) throw error;
  return void (await publisher.appendAsPlatform({
    type: "…/worker-update-failed",
    payload: { commitOid, generation, error: messageOf(error), unavailable: true },
  }));
}
```

### What changes

- The waits become jittered: 2.5–5 s, then 15–30 s.
- Each attempt gets its own 20 s bound, so the worst case is about 95 s instead of a hard 60 s.
- Retries and the give-up are logged, as the invariant asks.
- A TIMEOUT thrown inside an attempt now counts as an overload rather than a refusal.
- Outcomes, keys, cause and `#handledThrough` are unchanged.

### Pinned by

src/project/processor.test.ts: :632 (the 5 s and 30 s waits, give-up with unavailable, no timer left pending), :436, :487, :569 and :596.

### Skeptic's amended proposal

1. Put the schedule on the one short list, next to CI_HTTP in packages/shared/src/platform-retry.ts, and add `PUBLICATION` to the list in docs/engineering-invariants.md:

```ts
/** A publication of a project's config repo, which resolves its npm dependencies from esm.sh:
 *  met again after 5 s and 30 s, an overload too. */
export const PUBLICATION: Schedule = { delaysMs: [5_000, 30_000], repeatsOverload: true };
```

2. In processor.ts:

- Replace PUBLICATION_BUDGET_MS and PUBLICATION_ATTEMPT_WAITS_MS with `const PUBLICATION_ATTEMPT_MS = …;`.
- Drop the `unavailableError` import.
- Rewrite `#publish` as:

```ts
const kind = (error: unknown) =>
  errorCode(error) === "TIMEOUT" ? "overloaded" : failureKind(error);
let attempt: PublicationAttempt;
try {
  attempt = await retryPlatformFailures(
    () =>
      withTimeout(
        this.#attemptPublication(commitOid, generation, publisher),
        PUBLICATION_ATTEMPT_MS,
        `publication ${generation}`,
      ),
    {
      area: "project",
      schedule: PUBLICATION,
      idempotent: true,
      kind,
      describe: () => ({ name: "publication", commitOid, generation }),
    },
  );
} catch (error) {
  if (!isPlatformFailureKind(kind(error))) throw error;
  return void (await publisher.appendAsPlatform({
    type: "events.iterate.com/project/worker-update-failed",
    payload: {
      commitOid,
      generation,
      error: error instanceof Error ? error.message : String(error),
      unavailable: true,
    },
  }));
}
// then the two landOnce outcomes, unchanged
```

3. Choose PUBLICATION_ATTEMPT_MS knowingly. The total deadline cannot be kept without reintroducing a hand-rolled timer or signal.

- 60_000 keeps every attempt that succeeds today succeeding, but a run of hung attempts takes about 215 s to give up.
- 20_000 gives up within about 95 s, but cuts a cold 20-60 s esm.sh resolution and restarts it, since the module lock is stored only once the whole graph resolves.

4. Retitle processor.test.ts:632 to "met again on the PUBLICATION schedule". Put the real LOC in the PR: about −6 net, not −20.

### Skeptic's verdict

The core claim holds, but the candidate oversells the LOC and misses part of the semantic delta.

What is true:

- `#publish` (apps/os/src/project/processor.ts:606-665) is a second, private retry mechanism: a wait ladder with a leading 0, a total deadline checked before each wait, a hand-built Promise.race with its own clearTimeout, and `lastFailure` with continue/break. It sits beside the repo's one failure-model module (packages/shared/src/platform-retry.ts, "THE FAILURE MODEL, in one module").
- The ladder breaks the written invariant at docs/engineering-invariants.md:66-72: it is on no named list, it is not jittered, and its give-up is never logged.
- #3446 (merged; wt-main is at b3daf4846) only turned the outcome into one batch. The loop is untouched.

I applied the shape to an APFS clone of wt-main (draft kept at scratchpad/pubretry-draft.diff) and checked it:

- All 47 rows of src/project/processor.test.ts pass unchanged, :632 included.
- apps/os `tsc --noEmit` is clean.
- The :632 row now prints `project.platform-failure-retry` twice and `project.platform-failure-gave-up` once.

Corrections:

(d) LOC:

- processor.ts goes from 793 to 784 lines (−9). `#publish` goes from 60 to 52 lines, the constants from 8 to 4, and the imports grow by 4.
- The schedule has to join the named list in platform-retry.ts (+3), or the invariant argument collapses. A local `Schedule` constant is just as "on no list" as today's ladder.
- Net about −6 lines plus a one-word edit to the invariant list. The candidate's "about −20" is wrong.

(a) Semantic deltas the candidate missed:

1. The bound changes from a total 60 s deadline to a per-attempt one. With 20 s per attempt, a healthy attempt that takes 20-60 s succeeds today but is cut under the proposal. That is plausible for a cold esm.sh resolution: `resolveFromEsm` fetches the graph level by level, each fetch bounded at 20 s by ESM_FETCH_TIMEOUT_MS, and `lockedDependencyGraph` stores the lock only once the whole graph resolves, so the retry starts from scratch.
2. Abandoned attempts can overlap. After a timeout, the next attempt starts 2.5-5 s later while the first is still running. The worst case is three attempts in flight during an overload, or three hung probes of user code (a top-level await that never settles), where today there is one. manifestOf is read-only, so this costs load, not correctness.
3. A coded TIMEOUT thrown by `publisher.head()`, outside #attemptPublication's refusal catch, is now retried as an overload. Today it is rethrown and reported.
4. The new warn lines count toward the prd fault alarm's "platform-failure heals" row (scripts/ci/prd-fault-alarm.ts:398). The invariant intends that, but it is an ops-visible change.
5. Give-up comes later: about 95 s worst case with 20 s attempts, or about 215 s with 60 s attempts. `#publishing` is held all that time, so later commits and the deletion saga (processor.ts:401) wait with it.

Unchanged: the outcomes, the idempotency keys, the unkeyed `unavailable` give-up, the error text on fast failures, `#handledThrough` and the cause.

(b) Simpler: modestly, yes. The loop, the deadline arithmetic, the race timer and `lastFailure` are gone, and one new concept arrives: a two-line kind mapper that reads TIMEOUT as an overload, because `withTimeout` rejects with code TIMEOUT, which `failureKind` would otherwise read as a refusal. It is not lateral, since it removes a parallel retry mechanism, but the payoff is small.

(c) Guarantees: none is dropped. Recovery stays bounded, a hung attempt is still cut, the give-up is still an event, and the commit stays owed. Observability improves.

Tests: no test pins the hang or budget path. :632 is loose enough to pass with jitter, but its title ("after 5 s and 30 s") would need rewording.

Out of scope: the deletion saga's unjittered `[5_000, 30_000]` ladder at processor.ts:405-413 has the same invariant problem. It retries any error, not only platform failures, so it does not map onto retryPlatformFailures as-is.

## ProjectProcessor drops the creation flow only tests run, the nullable reaches production never passes, and two of its three 'newest state' copies

- Sweep index: 37; risk: low; payoff: 4/10
- LOC: About −13 net:
- processor.ts: about −9
- templates.test.ts: about −10
- processor.test.ts: about +6 (skeptic measured: Net −7, measured on the implemented, formatted and type-checked change:
- apps/os/src/project/processor.ts: +36/−40 (793 → 789)
- apps/os/src/project/templates.test.ts: +21/−38 (352 → 335)
- apps/os/src/project/processor.test.ts: +41/−27 (1379 → 1393)

Optionally, reusing `unreachable` for the unused getItx and download arguments in processor.test.ts would save about 3 more lines at each of about 6 construction sites, roughly −18.)

- Concepts: Before: 2 creation flows, 3 nullable reaches, 3 newest-state copies.
  After: 1 flow, 3 required reaches, 1 newest-state copy.

### Evidence

- apps/os/src/project/processor.ts:127-129 default hostnames, deletion and publisher to `() => null`.
- durable-object.ts:69-75 always passes all three, and its builders never return null (82-110, 116, 160).
- processor.ts:501-504 keeps a second creation saga that lands ingress-configured and project/created without a publisher.
- templates.test.ts:316-337 defaults `publishes = false`, and rows :24, :68, :100, :169, :180 and :215 assert that path.
- Guards that only the defaults make necessary:
  - `publisher &&` at :471 and :495
  - `if (!deletion) return` at :396
  - `hostnames?.` and `hostnames!` at :690, :713, :754-755 and :769-770
- #newestState (:146, :374), #newestHostnames (:153, :432, :446) and #unpublished (:164, :469, :587) all hold the newest delivered state.

### Current shape

The processor supports a project with no publisher, no deletion reach and no hostname reach, and most template tests exercise that flow. Each drain keeps its own copy of the latest state.

### Proposed shape

```ts
constructor(withItx, downloadTemplate, hostnames: () => ProjectHostnames, deletion: () => ProjectDeletion, publisher: () => ProjectPublisher)
if (!state.configRepoTip) return await this.#seed(state); // the seed's publication lands the certificate
#nextOwed() { return this.#newestState?.unpublishedCommits.find(({ offset }) => offset > this.#handledThrough); }
```

- Drop the `publisher &&`, `if (!deletion)` and `?.` guards.
- Tests get one `fakeReach()`.
- Template rows assert the seed, then the certificate after a delivery, as :240 already does.

### What changes

No production change. Tests stop asserting a flow that never runs. To stay identical, each drain checks `this.#newestState?.deletion` and stops, because the old copies froze at the deletion early-return.

### Pinned by

- src/project/templates.test.ts:24, 68, 100, 169, 180, 215 and :240
- processor.test.ts:704 (processorWithoutHostnames, :1085), :781, :830, :882, :971 and :1016

### Skeptic's amended proposal

ProjectProcessor: required reaches, one creation flow, one newest state.

processor.ts:

```ts
private readonly hostnames: () => ProjectHostnames;   // and deletion, publisher: no `| null`, no `= () => null`
/** The newest state any delivery has shown: an attempt that waited reads the contexts, hostnames
 *  and commits registered meanwhile, and a drain stops once it shows a deletion. */
#newestState: ProjectState | null = null;              // #newestHostnames and #unpublished deleted
...
async () => await this.hostnames().setPrimaryHostname(state.primaryHostname)
const deletion = this.deletion();                      // `if (!deletion) return;` deleted
...
let owed: typeof entry | undefined = entry; ...;
owed = this.#newestState?.deletion ? undefined : this.#newestState?.hostnames[hostname]
...
if (this.#nextOwed() && !this.#publishing) {
  const publisher = this.publisher();                  // built only when a publication starts
  this.#publishing = true; ...
}
if (state.configRepoTip && state.lastPublicationFactOffset === null) return;
...
// Its commit's fact reaches `/`, the follower publishes it, and the publication's fact lands the certificate.
if (!state.configRepoTip) return await this.#seed(state);
...
#nextOwed() {
  if (this.#newestState?.deletion) return undefined;
  return this.#newestState?.unpublishedCommits.find(({ offset }) => offset > this.#handledThrough);
}
```

- In `#addHostname`, `#removeHostname` and `#deletionPass`, `hostnames?.` becomes `hostnames.` and `hostnames!.` becomes `hostnames.`.
- Keep `provider?.`, because the provider really is null without a `customHostnames` block or a token.

Tests:

- **One shared stub.** Add one `function unreachable(): never { throw ... }` and pass it for every reach a row does not use. Do not write a fakeReach factory.
- **processor.test.ts :754.** Replace `processorWithoutHostnames()` with the same hostname fake and `provider: null`. That is the real production refusal path.
- **templates.test.ts `deliver`.**
  - Drop the `publishes` option and the fake publisher, and pass `unreachable` for hostnames, deletion and publisher. The template states owe no commit, so the publisher is never built.
  - Rows :24, :68, :100: drop the `order` and `project/created` assertions (not a real flow).
  - Rows :169, :180, :215: assert `fixture.append` was not called, meaning the refused seed is no failure.
  - Move the ingress payload assertion (`target: ["itx","config"]`) from :215 to the :240 row, after its publication fact.

Optional neighbouring trim: use `unreachable` for the unused getItx and download arguments too, at about −18 lines in processor.test.ts. Keep the recording getItx in the test at :892.

### Skeptic's verdict

The candidate holds, but it saves less than claimed. I built it in a scratch worktree at b3daf4846 (main, with #3446 merged). All 62 tests in processor.test.ts and templates.test.ts pass, apps/os `tsc --noEmit` is clean, and the files are formatted with oxfmt. The worktree is removed; the diff is at scratchpad/skeptic-projreach.diff.

(a) Semantics.

- **Production creation: no change.** durable-object.ts:69-75 always passes all three reaches, and `#publisher`, `#deletion` and `#hostnames` never return null. The only other constructions are in tests.
- **The flow being dropped is new, test-only cruft.** `if (publisher) return;` arrived today in 8c568dbf2 (2026-09-29). With no publisher, one delivery seeds and then lands ingress plus the certificate. Production never does that: it seeds, returns, and lands the certificate only once `lastPublicationFactOffset` is set.
- **Three copies of "newest state" are not the same thing.**
  - `#newestState` is set on every delivery.
  - `#newestHostnames` and `#unpublished` are set only on caught-up, non-deletion deliveries, so they quietly freeze once a deletion appears.
  - The comments say all three are "the newest state any delivery has shown". This mismatch is the hard-to-explain smell.
- **After the merge, behaviour changes in four small ways:**
  1. The drains read the newest reduced state, which can be a mid-batch state. Reduced state only moves forward and outcomes are keyed, so this is harmless; a drain may just start its next item a few events sooner.
  2. At a deletion, the drains stop after their current item instead of working through the frozen pre-deletion list. The deletion pass then removes every hostname in `#newestState` anyway, so deletion simply starts sooner.
  3. `this.publisher()` is built only when a publication starts. Today it is built on every caught-up delivery, which costs one `getByName` stub each time.
  4. The test at :754 now drives the real `provider: null` refusal instead of an impossible null reach.
- **The explicit deletion stop is required.** Without it, a drain could keep publishing new commits during a deletion, and the deletion's `while (#publishing)` wait could be starved. With it, that wait stays bounded.

(b) Simpler, yes: fewer concepts, lines roughly flat.

- Before: 2 creation flows, 3 nullable reaches with 5 guards, and 3 newest-state copies with an undocumented freeze at deletion.
- After: 1 flow, 0 nullable reaches, and 1 `#newestState` with an explicit "a drain stops at a deletion" check.
- The test growth is only the required arguments now spelled out at each construction.

(c) No guarantee is dropped. Creation still waits for the seed's publication, the deletion still runs alone and still waits for the drains, and every outcome is still keyed.

(d) LOC, re-measured with `git diff --numstat`, is −7 net, not the claimed −13:

- processor.ts: 793 → 789 (+36/−40).
- templates.test.ts: 352 → 335 (+21/−38).
- processor.test.ts: 1379 → 1393 (+41/−27).

Tests that pin the current behaviour:

- templates.test.ts rows :24, :68, :100, :169, :180 and :215 assert `project/created` after one delivery.
- templates.test.ts :240 uses `publishes: true`.
- processor.test.ts :754 uses `processorWithoutHostnames` to get the refusal.
- processor.test.ts constructions at :671, :708, :789, :841, :892, :983, :1033, :1097 and :1213.
- The drain tests at :437, :785, :836 and :979 pass unchanged.

Risk is low. The newest-state merge is the only part that is not mechanical.
