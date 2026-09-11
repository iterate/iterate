# Consent bootstrap review — Claude Fable 5.1 xhigh

Read-only design review, 2026-09-10. Requested model `claude-fable-5-1`, effort `xhigh`; tool access disabled. Completed successfully.

Pick candidate A, with two adjustments. The endpoint is the page's own path, `POST /authorize`, and the door verifies the cookie once per request and hands the root the claims. It is the only option that keeps the issuer cookie an issuer-only credential while adding one door and deleting two.

## Boundaries compared

- **A, pick.** Issuer cookie plus exact Origin admits a narrow consent root over Cap'n Web HTTP batch. Data in, data out. Adds one RpcTarget and one lint exception. Removes three server functions and the form handler.
- **B, reject.** A console grant bootstrapped mid-consent adds a nested authorization flow, a first-party auto-consent policy, and a grant row per bootstrap. The approve door still has to exist afterwards, so nothing collapses.
- **C, reject.** Admitting the cookie at the public gate breaks the stated invariant at the gate itself. The app proxy strips cookies before forwarding, so it also needs a proxy exception and a union SDK type that every future Session change must re-prove.
- **A with creation inside approve, reject.** Fewer methods, but the grant screen would show a project that does not exist yet. A failed mint would leave a silent directory write.
- **A over WebSocket, reject.** The cookie is checked once at handshake. Logout in another tab is invisible, expiry needs a deadline, and the upgrade path duplicates live lifetime machinery for no returned capability.

On the path: the `/.auth/*` prefix on the platform host is the console's OAuth client surface, which answers 404 for unknown paths under it. An issuer endpoint there confuses the two roles and depends on handler order. The authorize path already has a POST slot in the console door.

## Shape

Server side, in control-plane.ts. Type the root's constructor as a Pick of the database, the provider helper and the config inputs, so a context namespace is unreachable by type as well as by code.

```ts
// consoleHandler.fetch, before the Start entry: a signed-out GET never reaches the SPA
if (
  request.method === "GET" &&
  url.pathname === "/authorize" &&
  !(await issuerSessionOf(env, request))
)
  return redirectResponse(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);

// consoleDoor, replacing the form branch; POST-only, so this is never an upgrade
if (pathname === "/authorize") {
  const user = await issuerSessionOf(env, request);
  if (!user) return new Response("401: sign in first\n", { status: 401 });
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- cookie verified per request; every method returns data
  return newWorkersRpcResponse(request, new ConsentRoot(env, url.origin, user));
}

export class ConsentRoot extends RpcTarget {
  view(query: string): Promise<Consent>; // consentOf's body, plus orgs from listOrgs(user.sub)
  approve(query: string, chosen: string[]): Promise<{ redirectTo: string } | { error: string }>;
  createOrg(name: string): Promise<Org>; // directory.createOrg(user.sub, name)
  createProject(input: { orgId: string; project: string }): Promise<Project>;
  // directory.createProject({ userId: user.sub }, input.project, input.orgId)
}
```

Both consent functions lose their session lookup and request parameter. A private parse step shares client lookup and project filtering between view and approve.

Directory. `createProject` gains an optional org id. When given, one `listOrgs` read verifies membership and refuses otherwise. When omitted, the same read yields today's first-or-created org, which absorbs `ensureOrg`. The admin secret stays on the admin org. The public session gets the same input on project creation plus a `createOrg` for user reach only. Both doors then call the same two directory writes, and one directory test covers both. Leave `orgs()` as a method, since the console and Notes call it today.

SPA. The route becomes client-only, with one batch session per user action.

```tsx
export const Route = createFileRoute("/authorize")({ ssr: false, component: ConsentPage });
// eslint-disable-next-line iterate/no-capnweb-http-batch -- one bounded request per action; the cookie is rechecked each time
const consent = () => newHttpBatchRpcSession<ConsentRoot>("/authorize");

// mount:   using api = consent(); setAnswer(await api.view(query));
// create:  using api = consent();
//          const orgId = existing ?? api.createOrg(orgName).id;          // pipelined, one round trip
//          api.createProject({ orgId, project });
//          setAnswer(await api.view(query));                              // re-read, new project arrives checked
// approve: using api = consent(); const r = await api.approve(query, chosen);
//          "redirectTo" in r ? location.assign(r.redirectTo) : setError(r.error);
```

Creation UI renders only when the client is not project-bound. A user with no orgs sees an org name input defaulted from their email. Others see a select. Disable the button while pending, since the directory allows two orgs with one name. The switch-account form drops its JavaScript handler and posts to the logout path as it already does.

## Proof, collapses, tests

Security:

- **Cross-site writes.** The existing same-origin check refuses a foreign Origin before the door. If the issuer cookie is SameSite=Lax like the app cookie, it never rides a cross-site POST anyway. The door adds no CORS headers, so a cross-origin script cannot read a response.
- **No context reach.** The root imports nothing from the context module and holds no DO namespace or KV. Every method returns rows or the consent union, so no stub can outlive the batch. A one-line test can assert the import list.
- **Creation authority.** These are the user's own directory rights. Org creation binds the creator as owner. Project creation refuses an org the user is not in. The OAuth client widens nothing.
- **Approve unchanged.** Chosen ids are intersected with the user's memberships. D1 is strongly consistent, so a project created one batch earlier passes the same rule with no just-created special case.
- **Pending flow.** The issuer holds no state until the grant is minted. The query string is the whole request. Re-login through the login redirect resumes it, and PKCE is checked at the token endpoint as today.

Failure:

- **Cookie expires between steps.** The batch answers 401. The page shows a sign-in link carrying the same next. Created org and project persist and appear on return.
- **Name taken or foreign org.** Coded error rendered inline, retry with another name.
- **Provider refusal.** The redirect kind navigates the client, the invalid kind renders. Same as now.
- **Malformed body or a plain form post.** Cap'n Web answers 400. The no-JavaScript fallback is gone by decision.

Batch over WS: the cookie is the only credential and is re-read per request, which gives logout and expiry for free. WS could not observe a cleared cookie.

Collapses worth doing now:

1. **Verifier.** `verifyCredentials` keeps the admin branch only. The credentials type has one variant, the verifier drops its request and secrets inputs, and the session input's request field goes if nothing else reads it. Keep a runtime type check in authenticate because wire input is untyped. Rewrite the session.ts header, which still documents cookie and token doors.
2. **Consent plumbing.** Delete the two consent functions, the three server functions and the form branch. If the login route no longer needs the console context middleware, delete it and its type too.
3. **Directory.** Fold `ensureOrg` into the membership lookup. Drop the echoed query from the consent payload, since the client already holds it.
4. **Flag, next PR.** If no door verifies project tokens or the project secret any more, the two verifiers, the mint and rotate doors, and the project-doors threading are dead too. That touches iterate-context.ts, so leave it out of this change.

Tests: a workers test for the door with no cookie, a foreign Origin, and the full new-user path of view, create org, create project, view, approve, token exchange, then a project list over the public API that includes the new project. A directory unit for org membership on create. Replace the form-post authorize test with a 400 refusal. Then deploy and run the real-browser Claude connect.

## Follow-up

The user subsequently asked to reconsider whether every app login should also establish a session with a special issuer client, and requested further thinking/review rounds before implementation. The consent endpoint recommendation above is therefore provisional. The prompt also incorrectly called the issuer cookie short-lived; the implementation currently gives it a thirty-day lifetime. Later rounds must evaluate that actual lifecycle and revocation semantics.
