// Public /api starts with a session: the OAuth gate's, resolved on the upgrade, or one a bare
// socket authenticates IN-BAND — a bearer token, or the operator's admin secret. Sessions vend
// project contexts and own their teardown. What a session KNOWS — which projects and organizations
// exist, who reaches what — and what it DOES to them — create an organization or a project,
// rename, delete, a membership — is one call on the control plane (src/control-plane/edge.ts),
// made under this caller.

import { RpcTarget } from "capnweb";
import { z } from "zod";
import {
  normalizeConfigRepoTemplateReference,
  parseConfigRepoTemplateReference,
  formatConfigRepoTemplateReference,
} from "iterate/config-repo-template";
import type { IterateApi, StreamPage } from "iterate/api";
import { codedError, reportIssue } from "iterate/lib";
import { OAuthScope } from "iterate/oauth-scopes";
import type { Principal } from "iterate/principal";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import { pinPublicGithubTemplate } from "./repo/github-template.ts";
import { base64url, sha256Hex, verifyAdminSecret, type Caller } from "./caller.ts";
import type { Cause } from "./cause.ts";
import { templates } from "./generated/config-templates.js";
import type { ConsentRpcTarget } from "./consent.ts";
import type { GrantsRpcTarget } from "./grants.ts";
import { CONTEXT_DESTROYED, DurableObjectNameCodec, GLOBAL_PROJECT_ID } from "./context/paths.ts";
import {
  IterateContextRpcTarget,
  type IterateContextNamespace,
  type WaitUntil,
} from "./iterate-context.ts";
import {
  ADMIN_ORG_ID,
  type InvitationPreview,
  type InvitationRecord,
  type MemberRecord,
  type OrganizationRecord,
  type ProjectRecord,
  type UserRecord,
} from "./control-plane/catalog.ts";
import { type ControlPlane, describeReach, type Reach } from "./control-plane/edge.ts";
import { OrganizationRole } from "./organization/contract.ts";
import { iterateAppScopesOf, type AppConfig } from "./app-config.ts";
import { contextStub, facetStateOf } from "./context-stub.ts";
import type { AccountState, AuthenticationFact } from "./account/contract.ts";
import { IntegrationProvider } from "./integrations/contract.ts";
import { IdentityProvider } from "./control-plane/contract.ts";
import { assertSecretPath } from "./secrets.ts";

/** What `IterateRpcTarget.authenticate` accepts. `from-server-cookie` is the browser: the OAuth gate
 *  already resolved its session from the request, so it only says "hand me that session". `bearer`
 *  is a device or script, and always carries its `token` (capnweb's own pattern), which goes
 *  through the same gate (rpc.ts `resolveBearer`). `admin-secret` is the operator/CLI credential,
 *  verified in-band on any transport — a bare socket, or one the gate already resolved. */
const SessionCredentials = z.discriminatedUnion("type", [
  z.object({ type: z.literal("from-server-cookie") }),
  z.object({ type: z.literal("bearer"), token: z.string().min(1) }),
  z.object({
    type: z.literal("admin-secret"),
    secret: z.string(),
    as: z.object({ email: z.email() }).optional(),
  }),
]);
export type SessionCredentials = z.infer<typeof SessionCredentials>;

/** What every session is built from: the edge's bindings, the configuration and THIS request. */
export interface SessionInput {
  contextNamespace: IterateContextNamespace;
  waitUntil: WaitUntil;
  /** The control plane as the edge holds it: the catalog's reads and its commands. */
  controlPlane: ControlPlane;
  /** Configuration for operator authentication and context capabilities. */
  appConfig: AppConfig;
  /** THE PLATFORM ORIGIN this session was reached on (app-config.ts `platformAddressesOf`) — what
   *  every context it vends composes public URLs with (a DO isolate cannot know it: the caller
   *  carries it). */
  platformOrigin: string;
  /** The chain THIS request resumes, when it carries our mark (cause.ts): our own code calling the
   *  platform back. Absent, each call begins a chain of its own. */
  cause?: Cause;
  /** A live transport tracks projects whose capabilities it has handed out. */
  onProjectAccess?: (projectId: string) => void;
  /** The in-band bearer (rpc.ts): verify the token `authenticate` presents and bind the transport
   *  to its grant — null for a token the gate refuses. Absent where no `/api` root is served. */
  resolveBearer?: (token: string) => Promise<SessionAuthority | null>;
}

/** THE `/api` ROOT — the one thing a fresh capnweb connection holds. `authenticate(credentials)` is
 *  its only real verb: it returns the `SessionRpcTarget` you reach `.user`/`.projects`/… through.
 *  On a transport the OAuth gate resolved, `authenticate({ type: "from-server-cookie" })` hands back
 *  that session; a device or script presents its token in-band,
 *  `authenticate({ type: "bearer", token })`, and the operator
 *  `authenticate({ type: "admin-secret", secret })`, the deployment admin secret verified here.
 *  Its teardown owns every context the session it vends hands out. */
export class IterateRpcTarget extends RpcTarget implements IterateApi {
  readonly #input: SessionInput;
  readonly #sessionTeardown: SessionTeardown;
  /** The authority the transport already resolved (a credential on the upgrade), or null (a bare
   *  socket, which authenticates in-band). */
  readonly #resolved: SessionAuthority | null;

  constructor(
    input: SessionInput,
    sessionTeardown: SessionTeardown,
    resolved: SessionAuthority | null = null,
  ) {
    super();
    this.#input = input;
    this.#sessionTeardown = sessionTeardown;
    this.#resolved = resolved;
  }

  [Symbol.dispose](): void {
    this.#sessionTeardown.disposeAll();
  }

  async authenticate(input: unknown) {
    const credentials = SessionCredentials.safeParse(input);
    if (!credentials.success)
      throw codedError(
        "INVALID_CREDENTIALS",
        "authenticate({ type }): 'from-server-cookie' (browser), 'bearer' with its `token` (device or script) or 'admin-secret' (operator).",
      );
    if (credentials.data.type === "bearer") {
      // The same gate as a header on the upgrade, bound to this transport by rpc.ts. No account
      // fact — a device or script presenting its token on every reconnect is not a sign-in (the
      // grant's last use already records it).
      const resolved = await this.#input.resolveBearer?.(credentials.data.token);
      if (!resolved) throw codedError("INVALID_CREDENTIALS", "Invalid or revoked bearer");
      return new SessionRpcTarget(this.#input, this.#sessionTeardown, resolved);
    }
    if (credentials.data.type === "from-server-cookie") {
      if (!this.#resolved)
        throw codedError("UNAUTHENTICATED", "this transport carries no session — sign in first.");
      this.#publishAuthenticationFact(this.#resolved.principal, "from-server-cookie");
      return new SessionRpcTarget(this.#input, this.#sessionTeardown, this.#resolved);
    }
    const admin = await verifyAdminSecret(
      credentials.data.secret,
      this.#input.appConfig.secrets.adminBearer.exposeSecret(),
    );
    if (!admin) throw codedError("INVALID_CREDENTIALS", "The admin secret did not match.");
    // Test/operator fixture only; product impersonation must retain operator attribution. The
    // user is found or created in the control plane (a sign-in's own find-or-create).
    const user =
      credentials.data.as && (await this.#input.controlPlane.ensureUser(credentials.data.as.email));
    const principal = user ? { actor: user.id, email: user.email } : admin;
    this.#publishAuthenticationFact(principal, "admin-secret");
    // the operator acting as a user is that user with every scope
    return new SessionRpcTarget(this.#input, this.#sessionTeardown, {
      principal,
      reach: user ? { userId: user.id } : "every",
      ...(user && { scopes: [...OAuthScope.options] }),
    });
  }

  /** Record a successful authentication on the human's account context — best-effort and ASYNC (via
   *  waitUntil), off the connection's hot path: it is "nice to see", not authoritative, so a lost one
   *  on eviction is fine. Only a human (a principal with an email) has an account context — the admin
   *  and project credentials name none. The fact rides `session.user`'s stream, where the
   *  AccountProcessor folds it into the account view (src/account/contract.ts). NOTE: the boundary is
   *  per-authenticate for now (a reconnect re-publishes); narrowing it to credential-establishment is
   *  a later refinement. */
  #publishAuthenticationFact(
    principal: Principal,
    credential: "from-server-cookie" | "admin-secret",
  ): void {
    if (!principal.email) return;
    const operationId = crypto.randomUUID();
    publishPlatformFacts(
      this.#input,
      { account: principal.actor },
      {
        type: "events.iterate.com/account/authenticated",
        payload: { credential, at: Date.now(), operationId } satisfies AuthenticationFact,
        idempotencyKey: `account/authenticated/${operationId}`,
      },
      { principal },
    );
  }
}

/** Whose own context a platform fact lands on: a person's account (`global:/users/<id>`, folded by
 *  the `account` processor, src/account/) or an organization (`global:/organizations/<id>`, folded
 *  by `organization`, src/organization/). */
type FactOwner = { account: string } | { organization: string };

const ownerAddress = (owner: FactOwner) =>
  "account" in owner
    ? { processor: "account", path: `/users/${owner.account}` }
    : { processor: "organization", path: `/organizations/${owner.organization}` };

/** The owner's own context on the global project — where its facts land and its fold is read
 *  (oauth.ts `accountStateOf`) — called under the failure model (`contextStub`), its lines named
 *  `<area>.…`. */
export function ownerContext(
  contextNamespace: IterateContextNamespace,
  owner: FactOwner,
  area: string,
) {
  return contextStub(
    contextNamespace,
    DurableObjectNameCodec.address({
      projectId: GLOBAL_PROJECT_ID,
      path: ownerAddress(owner).path,
    }),
    area,
  );
}

/** PLATFORM FACTS, appended to their owner's own context, awaited and throwing: the owner's
 *  processor row first (a second enable appends nothing), then the facts in ONE call, so they land
 *  in the order given. Stamped with the caller, principal and grant — the audit lives where it
 *  happened, attributed to who did it and through which connection — and with `source.platform`,
 *  the one thing the processor folding them trusts (a person can append any type to their own
 *  context; the platform's fixed point, which no rewrite rule redirects, is the only writer of the
 *  stamp). A grant's end (grants.ts, the revocation truth) and a grant's use (oauth.ts) await it;
 *  the rest goes through `publishPlatformFacts`.
 *
 *  A `snapshot` or `liveSnapshot` read of the owner's processor already holds the facts once this
 *  returns: the facet host holds such a read until the pushes it owes the facet have landed
 *  (context/facet-host.ts `#callFacet`). `folded` is for a verb that reads the fold INSIDE the facet
 *  (`this.snapshot()`, such as AccountDurableObject `connectIntegration`; identity.ts
 *  `keepSignInToken` passes it for the connect that follows a sign-in): it waits on the processor's
 *  read-your-writes barrier (`waitUntilProcessed`, which catches up from the log itself and rejects
 *  after its ten seconds) through the last fact's offset. */
export async function appendPlatformFacts(
  contextNamespace: IterateContextNamespace,
  owner: FactOwner,
  facts: StreamEventInput | StreamEventInput[],
  caller: Caller,
  { folded = false }: { folded?: boolean } = {},
): Promise<void> {
  const context = ownerContext(contextNamespace, owner, "session");
  const events = Array.isArray(facts) ? facts : [facts];
  const { processor } = ownerAddress(owner);
  await context.invoke(["itx", "builtins", "processors", ["enable", processor]], [], caller);
  const appended = (await context.invoke(["itx", "builtins", ["append", ...events]], [], {
    ...caller,
    platform: true,
  })) as StreamEvent[];
  const offset = appended.at(-1)?.offset;
  if (folded && offset !== undefined)
    await context.invoke(
      ["itx", "builtins", "facets", ["get", processor], ["waitUntilProcessed", { offset }]],
      [],
      caller,
    );
}

/** AN ORGANIZATION'S ACTIVITY: a verb's facts — on the organization's own context and, for a
 *  membership, on the member's account — published in the background (`publishPlatformFacts`) once
 *  the control-plane database has made the write. THE DATABASE IS THE TRUTH of organizations,
 *  members, invitations and projects, and what the dash reads (`organizations.list`, `members`,
 *  `invitations`, `projects.list`); a fact is the record of who did what, and the dash's signal to
 *  read again (apps/dash components/organization-tree.tsx), so it lands after the write it records.
 *  Each fact is keyed by this operation (or by its own key: a project is added once), so the one
 *  retry lands it once. */
function publishOrganizationFacts(
  input: Pick<SessionInput, "contextNamespace" | "waitUntil">,
  caller: Caller,
  landings: [FactOwner, StreamEventInput[]][],
): void {
  const operation = crypto.randomUUID();
  for (const [owner, facts] of landings)
    publishPlatformFacts(
      input,
      owner,
      facts.map((fact, index) => ({
        idempotencyKey: `organization/${operation}/${index}`,
        ...fact,
      })),
      caller,
    );
}

/** A person who left an organization: every project they no longer reach stops using their
 *  accounts — each such lend of theirs ends (`secret/lend-revoked { reason: "membership-ended" }` on
 *  both sides, and `<provider>/disconnected` on the project's root). Their
 *  reach is read fresh, past the edge's memo, since it just changed. A use the sweep has not reached
 *  yet is refused at the lender all the same (secret/durable-object.ts `admitLend`). */
async function endLendsOutOfReach(
  input: Pick<SessionInput, "contextNamespace" | "controlPlane">,
  userId: string,
): Promise<void> {
  const account = ownerContext(input.contextNamespace, { account: userId }, "session");
  const state = await facetStateOf<AccountState>(account, "account", { principal: null });
  const reached = new Set(
    (await input.controlPlane.accessibleTo(userId, true)).projects.map((project) => project.id),
  );
  for (const [path, row] of Object.entries(state.secrets))
    for (const [lendId, lend] of Object.entries(row.lends || {}))
      if (!reached.has(lend.to))
        await account.invoke(
          [
            "itx",
            "builtins",
            "secrets",
            ["revokeLend", path, lendId, { reason: "membership-ended" }],
          ],
          [],
          { principal: null, platform: true },
        );
}

/** A project creation that answers this late logs where it waited (`session.project-create-slow`).
 *  p50 1.9 s, p99 5.5 s with 1, 10 and 25 people creating at once (os-latency, 2026-09-24). */
const SLOW_CREATE_MS = 5_000;

/** How long each call a project creation waits on took, by step: logged once when the creation
 *  took SLOW_CREATE_MS or longer, answered or thrown, so the log names the Durable Object that held
 *  it. A platform stall on a brand-new object's first call or first write logs nothing of its own. */
class CreateWaits {
  readonly #started = Date.now();
  readonly #steps: Record<string, number> = {};

  async time<T>(step: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await work();
    } finally {
      this.#steps[step] = Date.now() - started;
    }
  }

  report(attributes: { projectId?: string; orgId?: string }): void {
    const ms = Date.now() - this.#started;
    if (ms < SLOW_CREATE_MS) return;
    const [slowest] = Object.entries(this.#steps).sort(([, a], [, b]) => b - a)[0] ?? [];
    console.warn({
      event: "session.project-create-slow",
      ms,
      slowest,
      steps: this.#steps,
      ...attributes,
    });
  }
}

/** THE DEPLOYMENT'S LENDS TO EVERY PROJECT, borrowed by a project just created (context/built-ins.ts
 *  `borrowEveryProjectLends`, on the global root), before the answer: the project's first
 *  `getSecret` of a lent path finds it. Never fails the creation: a borrow that fails is reported
 *  there, and the project lacks that path until the same creation runs again. */
async function borrowEveryProjectLends(
  input: Pick<SessionInput, "contextNamespace">,
  projectId: string,
  caller: Caller,
): Promise<void> {
  const root = input.contextNamespace.getByName(
    DurableObjectNameCodec.stringify({ projectId: GLOBAL_PROJECT_ID, path: "/" }),
  );
  try {
    await root.invoke(["itx", "builtins", "secrets", ["borrowEveryProjectLends", projectId]], [], {
      ...caller,
      platform: true,
    });
  } catch (error) {
    reportIssue("session.every-project-lends", error, { projectId });
  }
}

type KeyedFact = StreamEventInput & { idempotencyKey: string };

/** `appendPlatformFacts` best-effort and ASYNC (waitUntil), off the verb's own path: the account's
 *  sign-ins and consents, and an organization's activity — facts no answer depends on. Each is
 *  KEYED (its sign-in's operation, its consent's grant, its organization verb's operation), so
 *  running the append twice lands the fact once: the stream answers a key it holds with the event
 *  it already has, and `ownerContext` sends an append the platform cut ONCE more. A second failure,
 *  and any other, is reported, as oauth.ts reports a grant use it could not record. */
export function publishPlatformFacts(
  input: Pick<SessionInput, "contextNamespace" | "waitUntil">,
  owner: FactOwner,
  facts: KeyedFact | KeyedFact[],
  caller: Caller,
): void {
  const events = Array.isArray(facts) ? facts : [facts];
  input.waitUntil(
    appendPlatformFacts(input.contextNamespace, owner, events, caller).catch((error) =>
      reportIssue("session.platform-fact-not-recorded", error, {
        path: ownerAddress(owner).path,
        type: events.map((event) => event.type).join(" "),
      }),
    ),
  );
}

/** A project on its organization's activity: `organization/project-added`, keyed by the project
 *  (a creation asked again lands it once), after the organization's creation and its owner when
 *  this creation minted it (a person's first project, catalog.ts `createProject`) — the owner's
 *  membership on their account too. The deployment's own organization (the operator's projects
 *  with no `orgId`) has no members and no page: nothing lands there. */
function publishProjectAdded(
  input: Pick<SessionInput, "contextNamespace" | "waitUntil">,
  project: ProjectRecord & { mintedOrganization?: string },
  caller: Caller,
): void {
  if (project.orgId === ADMIN_ORG_ID) return;
  const added = {
    type: "events.iterate.com/organization/project-added",
    payload: { projectId: project.id, slug: project.slug },
    idempotencyKey: `organization/project-added:${project.id}`,
  };
  if (!project.mintedOrganization)
    return publishOrganizationFacts(input, caller, [[{ organization: project.orgId }, [added]]]);
  const membership = memberAddedFact(project.orgId, caller.principal!.actor, "owner");
  publishOrganizationFacts(input, caller, [
    [
      { organization: project.orgId },
      [orgCreatedFact(project.mintedOrganization), membership, added],
    ],
    [{ account: caller.principal!.actor }, [membership]],
  ]);
}

/** The facts more than one verb lands (their shapes are the organization contract's,
 *  src/organization/): a membership rides the organization's log and the member's account alike. */
const orgCreatedFact = (name: string): StreamEventInput => ({
  type: "events.iterate.com/organization/created",
  payload: { name },
  idempotencyKey: "organization/created",
});
const memberAddedFact = (orgId: string, userId: string, role: OrganizationRole) => ({
  type: "events.iterate.com/organization/member-added",
  payload: { orgId, userId, role },
});
const memberRemovedFact = (orgId: string, userId: string) => ({
  type: "events.iterate.com/organization/member-removed",
  payload: { orgId, userId },
});

/** What you authenticate into: a catalog that vends contexts. A session is NOT a context — it is
 *  the directory you reach one through. */
export type SessionAuthority = {
  principal: Principal;
  /** The OAuth grant this session IS — the connection, stamped beside the principal on every event
   *  (`source.grant`); absent for the admin secret and the in-band cookie/admin authenticate. */
  grant?: string;
  reach: Reach;
  grants?: GrantsRpcTarget;
  consent?: ConsentRpcTarget;
  scopes?: string[];
};

export class SessionRpcTarget extends RpcTarget {
  readonly #sessionTeardown: SessionTeardown;
  readonly #projects: ProjectCollectionRpcTarget;
  readonly #organizations: OrganizationCollectionRpcTarget;
  readonly #users: UserCollectionRpcTarget;
  readonly #contexts: ContextSweepRpcTarget;
  readonly #input: SessionInput;
  readonly #authority: SessionAuthority;

  constructor(input: SessionInput, sessionTeardown: SessionTeardown, authority: SessionAuthority) {
    super();
    this.#input = input;
    this.#authority = authority;
    this.#sessionTeardown = sessionTeardown;
    const session: SessionOf = {
      input,
      authority,
      caller: this.#caller,
      globalContext: (path) => this.#globalContext(path),
      organizationsWriter: (verb) => this.#organizationsWriter(verb),
    };
    this.#projects = new ProjectCollectionRpcTarget(session, sessionTeardown);
    this.#organizations = new OrganizationCollectionRpcTarget(session);
    this.#users = new UserCollectionRpcTarget(session);
    this.#contexts = new ContextSweepRpcTarget(session);
  }

  [Symbol.dispose](): void {
    this.#sessionTeardown.disposeAll();
  }

  /** Attribution comes from the admission gate, never from the caller. */
  whoami(): Principal {
    return this.#authority.principal;
  }

  /** The operator's project-seed CLI. User sessions, including impersonated users, cannot
   * export secret cells. Address the native context directly, outside project rewrites. */
  async exportProjectSecretForSeed(projectRef: string, path: string): Promise<unknown> {
    if (this.#authority.principal.actor !== "admin" || this.#authority.reach !== "every")
      throw codedError("FORBIDDEN", "Project-seed exports require operator authority.");
    const project = await this.#input.controlPlane.getProject(z.string().min(1).parse(projectRef));
    if (!project) throw codedError("INVALID_INPUT", "Project not found.");
    const name = DurableObjectNameCodec.stringify({
      projectId: project.id,
      path: assertSecretPath(z.string().parse(path)),
    });
    return this.#input.contextNamespace
      .getByName(name)
      .exportSecretForProjectSeed(this.#input.appConfig.secrets.adminBearer.exposeSecret());
  }

  /** The deploy's readiness gate's (scripts/os/preview-readiness.ts), the operator's alone: the version
   *  this edge runs and the one each named project's root context runs, at most eight. A project
   *  nobody has touched gets a brand-new context by the asking, which is the point: while Cloudflare
   *  releases a redeploy, a brand-new Durable Object can still start on the previous version. */
  async versions(projectIds: string[]) {
    if (this.#authority.principal.actor !== "admin" || this.#authority.reach !== "every")
      throw codedError("FORBIDDEN", "Deployment versions are the operator's.");
    const contexts = z
      .array(z.string())
      .max(8)
      .parse(projectIds)
      .map((projectId) =>
        this.#input.contextNamespace
          .getByName(DurableObjectNameCodec.address({ projectId, path: "/" }).name)
          .version(),
      );
    return { edge: this.#input.appConfig.deployId, contexts: await Promise.all(contexts) };
  }

  /** Safe bootstrap data for every app, regardless of which host serves it. */
  info() {
    return {
      principal: this.#authority.principal,
      scopes: this.#authority.scopes ?? [],
      platformOrigin: this.#input.platformOrigin,
      ingressRouting: this.#input.appConfig.urls.ingressRouting,
      mcpOrigin: this.#input.appConfig.urls.mcp,
      iterateAppProviders: IntegrationProvider.options.filter((provider) =>
        Boolean(this.#input.appConfig.integrations[provider]),
      ),
      iterateAppScopes: iterateAppScopesOf(this.#input.appConfig),
      // as identity.ts `signInClientOf`: the sign-in's block, and the integration's client it uses
      signInProviders: IdentityProvider.options.filter(
        (provider) =>
          Boolean(this.#input.appConfig.login[provider]) &&
          Boolean(this.#input.appConfig.integrations[provider]),
      ),
    };
  }

  /** Creating, renaming or deleting an organization, or changing its members, is the
   *  `organizations:write` scope's: a user grant whose consent kept it ticked (the dash asks for
   *  it; the consent page lets the person untick it), the issuer's own session, or the operator —
   *  acting as a user, or as the operator. The grant's project
   *  reach is beside the point — an organization is the person's, and the grant reaches what it
   *  reached before. */
  #organizationsWriter(verb: string): void {
    const { reach, scopes } = this.#authority;
    if (reach === "every") return;
    if (!("userId" in reach))
      throw codedError("FORBIDDEN", `A user session is required to ${verb} an organization.`);
    if (!scopes?.includes("organizations:write"))
      throw codedError(
        "FORBIDDEN",
        `The organizations:write permission is required to ${verb} an organization.`,
      );
  }

  /** WHO this session is, as an event's stamp: the principal and the grant it acts through. */
  get #caller(): Caller {
    const { principal, grant, scopes } = this.#authority;
    return {
      principal,
      grant,
      platformOrigin: this.#input.platformOrigin,
      cause: this.#input.cause,
      ...(grant && scopes?.includes("account") && !principal.impersonatedBy && { account: true }),
    };
  }

  get consent() {
    if (!this.#authority.consent)
      throw codedError("FORBIDDEN", "Sign in to iterate to approve access.");
    return this.#authority.consent;
  }

  get grants() {
    if (!this.#authority.grants)
      throw codedError("FORBIDDEN", "This session cannot manage OAuth grants.");
    return this.#authority.grants;
  }

  logout() {
    return this.grants.endCurrent();
  }

  /** The project catalog. A GETTER, not a field: capnweb (like Workers RPC) exposes prototype
   *  members only — an instance property is private state and is refused over the wire. */
  get projects(): ProjectCollectionRpcTarget {
    return this.#projects;
  }

  /** The organizations this session can reach: `list()` (the rows, with the person's role),
   *  `get(orgId)` (the organization's context — a global IterateContextRpcTarget at
   *  `(global, /organizations/<orgId>)`, the same context surface as a user or a project — by
   *  membership), and the verbs, each one call on the control plane. */
  get organizations(): OrganizationCollectionRpcTarget {
    return this.#organizations;
  }

  /** THE PEOPLE — the operator's catalog and a platform admin's (reach `every`, oauth.ts): every
   *  other session names one person, itself. */
  get users(): UserCollectionRpcTarget {
    if (this.#authority.reach !== "every")
      throw codedError("FORBIDDEN", "Only the operator reads the user catalog.");
    return this.#users;
  }

  /** THE GLOBAL NAMESPACE'S ROOT `/`, for the operator: a context is (namespace, path), the
   *  namespace a project or the global one, and this handle's `cd` walks the global namespace as a
   *  project's walks its project — `global.cd("/users/<id>")`, `/organizations/<id>…`
   *  (iterate-context.ts) — and its `secrets` are the deployment's own, lent to projects
   *  (context/built-ins.ts `lend`). For a person holding the `admin` scope (reach `every` only
   *  while `admins` lists them, oauth.ts), and for the operator bearer itself (actor `admin`, no
   *  person: a script such as scripts/os/seed-instance-secrets.ts); not for anyone else, whose global
   *  contexts stay reached by identity (`user`, `organizations.get`). */
  get global(): IterateContextRpcTarget {
    const { principal, reach, scopes } = this.#authority;
    const operatorBearer = principal.actor === "admin" && !principal.email;
    const platformAdmin = Boolean(principal.email) && scopes?.includes("admin");
    if (reach !== "every" || !(operatorBearer || platformAdmin))
      throw codedError("FORBIDDEN", "Only a platform admin opens the global namespace.");
    return this.#globalContext("/", true);
  }

  /** THE CONTEXT SWEEP's reach (scripts/ci/context-sweep.ts) — the operator's alone: every
   *  context Cloudflare lists, by id. */
  get contexts(): ContextSweepRpcTarget {
    if (this.#authority.reach !== "every")
      throw codedError("FORBIDDEN", "Only the operator sweeps contexts.");
    return this.#contexts;
  }

  /** The signed-in human's own context in the deployment-global namespace — an ORDINARY
   *  IterateContextRpcTarget at `(global, /users/<userId>)`, the exact surface a project context
   *  has (`session.user` is `session.projects.get(...)` one namespace over). A getter, like
   *  `projects`. Refused for the admin credential — it names no human. */
  get user(): IterateContextRpcTarget {
    const { principal, reach } = this.#authority;
    if (!principal.email)
      throw codedError(
        "FORBIDDEN",
        "this credential identifies no user — the admin credential names no `.user` context",
      );
    // A grant bound to projects (a personal access token a device holds) reaches those projects
    // and nothing of the person's own: the user context is the account, not a project.
    if (reach !== "every" && "projectIds" in reach)
      throw codedError(
        "FORBIDDEN",
        "this credential is bound to projects — it opens no `.user` context",
      );
    return this.#globalContext(`/users/${principal.actor}`);
  }

  /** A context in the deployment-global namespace (the control plane's own): an ordinary
   *  IterateContextRpcTarget at `(GLOBAL_PROJECT_ID, path)`, carrying this session's principal. THE
   *  ONLY WAY TO A GLOBAL CONTEXT: `user` and `organizations.get` vend one by IDENTITY (the session's
   *  own user, an org it belongs to) and the handle's `cd` is refused (iterate-context.ts), so no
   *  caller can name another global path — the path mask with no policy table. */
  #globalContext(path: string, globalPaths = false): IterateContextRpcTarget {
    return new IterateContextRpcTarget(
      this.#input.contextNamespace,
      DurableObjectNameCodec.address({ projectId: GLOBAL_PROJECT_ID, path }),
      this.#sessionTeardown,
      this.#input.waitUntil,
      this.#caller,
      globalPaths,
    );
  }
}

/** What the collections below share of their session. */
type SessionOf = {
  input: SessionInput;
  authority: SessionAuthority;
  /** The verified caller — principal and grant — stamped on every request and context event. */
  caller: Caller;
  globalContext(path: string): IterateContextRpcTarget;
  organizationsWriter(verb: string): void;
};

/** The organization catalog — THE DASH'S READ of organizations, straight from the control-plane
 *  database: `list()` is the person's organizations, with their role (a grant narrowed to projects
 *  sees only the organizations those projects belong to — unless it holds `organizations:write`,
 *  which is the organizations themselves); `members(orgId)` and an owner's `invitations(orgId)` are
 *  one organization's; `get(orgId)` vends the organization's context — its activity — BY MEMBERSHIP
 *  (an org the session does not reach is FORBIDDEN, exactly as `projects.get` outside its reach).
 *  `create`, `rename`, `delete`, `addMember`, `removeMember`, `createInvitation`,
 *  `revokeInvitation` and `acceptInvitation` are each one call on the control plane under this
 *  caller, which checks the rest (an owner? the last owner? projects still held? a link still
 *  open?) against its catalog, and then publish the verb's facts (`publishOrganizationFacts`). */
class OrganizationCollectionRpcTarget extends RpcTarget {
  readonly #session: SessionOf;
  constructor(session: SessionOf) {
    super();
    this.#session = session;
  }

  /** The organizations this session reaches, narrowed as the docstring says. `fresh` re-reads the
   *  person's memberships past the isolate's memo. */
  async #reachable(fresh = false): Promise<OrganizationRecord[]> {
    const { reach, scopes } = this.#session.authority;
    const { controlPlane } = this.#session.input;
    if (reach === "every") return controlPlane.listOrganizations();
    if (!("userId" in reach)) return [];
    const record = await controlPlane.accessibleTo(reach.userId, fresh);
    if (!("projectIds" in reach) || scopes?.includes("organizations:write"))
      return record.organizations;
    const chosen = record.projects.filter((project) => reach.projectIds!.includes(project.id));
    return record.organizations.filter((organization) =>
      chosen.some((project) => project.orgId === organization.id),
    );
  }

  /** `orgId`, when this session reaches it, as `list()` narrows it: a grant bound to projects
   *  reaches only the organizations those projects belong to (unless it holds
   *  `organizations:write`), so a personal access token opens no other organization. The admin
   *  reaches every one. A miss is re-read once past the memo before it is refused: a membership
   *  that just landed is admitted at once. */
  async #reached(verb: string, orgId: string): Promise<string> {
    // ONE path segment — the catalog's `org_<hex>` — never a path: the id is interpolated into
    // `/organizations/<id>`, and `..` or `x/../users/<id>` would canonicalize onto another global
    // context (the admin reaches every org, so the membership check alone would not catch it).
    const id = z.string().trim().min(1).parse(orgId);
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw codedError(
        "FORBIDDEN",
        `organizations.${verb}(${JSON.stringify(id)}): an organization id is one path segment, never a path`,
      );
    const reaches = (organizations: OrganizationRecord[]) =>
      organizations.some((organization) => organization.id === id);
    const reachable =
      this.#session.authority.reach === "every" ||
      reaches(await this.#reachable()) ||
      reaches(await this.#reachable(true));
    if (!reachable)
      throw codedError(
        "FORBIDDEN",
        `organizations.${verb}(${JSON.stringify(id)}): not an organization this session belongs to`,
      );
    return id;
  }

  /** Oldest first, read fresh, past the isolate's memo: the dash reads it again when a fact says it
   *  changed. */
  list(): Promise<OrganizationRecord[]> {
    return this.#reachable(true);
  }

  async get(orgId: string): Promise<IterateContextRpcTarget> {
    return this.#session.globalContext(`/organizations/${await this.#reached("get", orgId)}`);
  }

  /** An organization's members, with their emails and when they joined, in that order — for every
   *  session that reaches it (the dash's members table, the project-seed CLI's capture). */
  async members(orgId: string): Promise<MemberRecord[]> {
    const id = await this.#reached("members", orgId);
    return this.#session.input.controlPlane.listMembers(id);
  }

  /** An organization's invitation links still open, oldest first — its owners' (the dash's list
   *  to revoke from), and the operator's; anyone else is refused FORBIDDEN. An expired link stays
   *  until revoked: `expiresAt` says it. */
  async invitations(orgId: string): Promise<InvitationRecord[]> {
    const { input, caller } = this.#session;
    return input.controlPlane.listInvitations(caller, await this.#reached("invitations", orgId));
  }

  /** A new organization named `name`, the person its owner. The operator may name the owner. */
  async create(input: { name: string; ownerId?: string }): Promise<OrganizationRecord> {
    this.#session.organizationsWriter("create");
    const data = z
      .object({
        name: z.string().trim().min(1, "Enter an organization name."),
        ownerId: z.string().optional(),
      })
      .parse(input);
    const { input: sessionInput, caller } = this.#session;
    const record = await sessionInput.controlPlane.createOrganization(caller, data);
    // The operator's scripts add members themselves (an owner named by the operator gets no
    // session here).
    const created = orgCreatedFact(record.name);
    if (record.role === "owner") {
      const membership = memberAddedFact(record.id, caller.principal!.actor, "owner");
      publishOrganizationFacts(sessionInput, caller, [
        [{ organization: record.id }, [created, membership]],
        [{ account: caller.principal!.actor }, [membership]],
      ]);
    } else
      publishOrganizationFacts(sessionInput, caller, [[{ organization: record.id }, [created]]]);
    return record;
  }

  /** Rename an organization the person owns. */
  async rename(orgId: string, input: { name: string }): Promise<OrganizationRecord> {
    this.#session.organizationsWriter("rename");
    const data = z
      .object({ name: z.string().trim().min(1, "Enter an organization name.") })
      .parse(input);
    const { input: sessionInput, caller } = this.#session;
    const organizationId = z.string().min(1).parse(orgId);
    const record = await sessionInput.controlPlane.renameOrganization(
      caller,
      organizationId,
      data.name,
    );
    publishOrganizationFacts(sessionInput, caller, [
      [
        { organization: organizationId },
        [{ type: "events.iterate.com/organization/renamed", payload: { name: record.name } }],
      ],
    ]);
    return { ...record, role: "owner" };
  }

  /** Delete an organization the person owns, while it holds no project. The deletion lands on the
   *  organization's own context, and each membership's end on the member's account. */
  async delete(orgId: string): Promise<void> {
    this.#session.organizationsWriter("delete");
    const { input: sessionInput, caller } = this.#session;
    const organizationId = z.string().min(1).parse(orgId);
    // The members, read before the delete refuses or succeeds — to end their memberships below.
    const members = await sessionInput.controlPlane.listMembers(organizationId);
    await sessionInput.controlPlane.deleteOrganization(caller, organizationId);
    publishOrganizationFacts(sessionInput, caller, [
      ...members.map(({ userId }): [FactOwner, StreamEventInput[]] => [
        { account: userId },
        [memberRemovedFact(organizationId, userId)],
      ]),
      [
        { organization: organizationId },
        [
          {
            type: "events.iterate.com/organization/deleted",
            payload: {},
            idempotencyKey: "organization/deleted",
          },
        ],
      ],
    ]);
  }

  /** Add a person to an organization the caller owns, as an owner or a member. */
  async addMember(
    orgId: string,
    input: { userId: string; role?: OrganizationRole },
  ): Promise<void> {
    this.#session.organizationsWriter("add a member to");
    const data = z
      .object({ userId: z.string().min(1), role: OrganizationRole.default("member") })
      .parse(input);
    const { input: sessionInput, caller } = this.#session;
    const organizationId = z.string().min(1).parse(orgId);
    const userId = await sessionInput.controlPlane.addMember(caller, organizationId, data);
    const fact = memberAddedFact(organizationId, userId, data.role);
    publishOrganizationFacts(sessionInput, caller, [
      [{ organization: organizationId }, [fact]],
      [{ account: userId }, [fact]],
    ]);
  }

  /** Remove a person from an organization the caller owns. */
  async removeMember(orgId: string, input: { userId: string }): Promise<void> {
    this.#session.organizationsWriter("remove a member from");
    const data = z.object({ userId: z.string().min(1) }).parse(input);
    const { input: sessionInput, caller } = this.#session;
    const organizationId = z.string().min(1).parse(orgId);
    const userId = await sessionInput.controlPlane.removeMember(caller, organizationId, data);
    const fact = memberRemovedFact(organizationId, userId);
    publishOrganizationFacts(sessionInput, caller, [
      [{ organization: organizationId }, [fact]],
      [{ account: userId }, [fact]],
    ]);
    await endLendsOutOfReach(sessionInput, userId);
  }

  /** A new INVITATION LINK to an organization the caller owns: whoever signs in and accepts it
   *  first joins in `role` (default member), until it expires (`expiresInDays`, default 7, at most
   *  30). Answers the invitation with its `token` — the link's secret, shown this once (the
   *  control plane keeps only its SHA-256); the dash puts it in `/invitations/<token>`.
   *  `invitations(orgId)` lists it as open until it is accepted or revoked. `emailHint` is who it
   *  is meant for, a note for the owners — never checked against who accepts. */
  async createInvitation(
    orgId: string,
    input: { role?: OrganizationRole; emailHint?: string; expiresInDays?: number } = {},
  ): Promise<InvitationRecord & { token: string }> {
    this.#session.organizationsWriter("invite people to");
    const data = z
      .object({
        role: OrganizationRole.default("member"),
        emailHint: z
          .string()
          .trim()
          .max(200)
          .optional()
          .transform((hint) => hint || undefined),
        expiresInDays: z.number().int().min(1).max(30).default(7),
      })
      .parse(input);
    const { input: sessionInput, caller } = this.#session;
    const organizationId = z.string().min(1).parse(orgId);
    const token = mintInvitationToken();
    const invitation = await sessionInput.controlPlane.createInvitation(caller, organizationId, {
      tokenHash: await sha256Hex(token),
      role: data.role,
      emailHint: data.emailHint,
      expiresAt: Date.now() + data.expiresInDays * 86_400_000,
    });
    publishOrganizationFacts(sessionInput, caller, [
      [
        { organization: organizationId },
        [
          {
            type: "events.iterate.com/organization/invitation-created",
            payload: {
              invitationId: invitation.id,
              role: invitation.role,
              emailHint: invitation.emailHint,
              expiresAt: invitation.expiresAt,
            },
          },
        ],
      ],
    ]);
    return { ...invitation, token };
  }

  /** Withdraw an open invitation link of an organization the caller owns, by its id; again is a
   *  no-op. */
  async revokeInvitation(orgId: string, input: { invitationId: string }): Promise<void> {
    this.#session.organizationsWriter("revoke an invitation to");
    const data = z.object({ invitationId: z.string().min(1) }).parse(input);
    const { input: sessionInput, caller } = this.#session;
    const organizationId = z.string().min(1).parse(orgId);
    await sessionInput.controlPlane.revokeInvitation(caller, organizationId, data.invitationId);
    publishOrganizationFacts(sessionInput, caller, [
      [
        { organization: organizationId },
        [
          {
            type: "events.iterate.com/organization/invitation-revoked",
            payload: { invitationId: data.invitationId },
          },
        ],
      ],
    ]);
  }

  /** What an invitation link opens, for the signed-in person holding it — the organization's name
   *  and id, the role, whether it can still be accepted (`status`), and whether they already
   *  belong (`member`). Null for a link that names no invitation. The token IS the permission: no
   *  membership is needed to read it. */
  async invitation(token: string): Promise<InvitationPreview | null> {
    const { reach } = this.#session.authority;
    if (reach !== "every" && !("userId" in reach))
      throw codedError("FORBIDDEN", "A user session is required to read an invitation.");
    return this.#session.input.controlPlane.getInvitation(
      await sha256Hex(z.string().min(1).parse(token)),
      reach === "every" ? null : reach.userId,
    );
  }

  /** Join the organization an invitation link opens, as the signed-in person, in the link's role.
   *  Single use: the first person to accept consumes it — accepting again answers the same, anyone
   *  after is refused (INVALID_INPUT), as is a revoked or expired link. A person already a member
   *  keeps their role and the link stays open. Answers the organization's row as the person now
   *  reads it. */
  async acceptInvitation(token: string): Promise<OrganizationRecord> {
    this.#session.organizationsWriter("join");
    const { input: sessionInput, caller } = this.#session;
    const { invitation, userId, role, accepted } = await sessionInput.controlPlane.acceptInvitation(
      caller,
      await sha256Hex(z.string().min(1).parse(token)),
    );
    // published again on a retry by the same person: `role` is the membership as it stands, so the
    // activity never shows a promotion since rewound
    if (accepted) {
      const membership = memberAddedFact(invitation.orgId, userId, role);
      publishOrganizationFacts(sessionInput, caller, [
        [
          { organization: invitation.orgId },
          [
            {
              type: "events.iterate.com/organization/invitation-accepted",
              payload: { invitationId: invitation.id, userId },
            },
            membership,
          ],
        ],
        [{ account: userId }, [membership]],
      ]);
    }
    const row = (await sessionInput.controlPlane.accessibleTo(userId, true)).organizations.find(
      (organization) => organization.id === invitation.orgId,
    );
    if (!row) throw new Error(`accepted ${invitation.id} but ${userId} is no member`);
    return row;
  }
}

/** The project catalog: `list()`, `get(project)`, `create({ project })` — get and create vend the
 *  project's root context. What a session reaches is its `Reach` (control-plane/edge.ts): every
 *  project, the projects of the user's orgs, or the projects named outright. */
class ProjectCollectionRpcTarget extends RpcTarget {
  readonly #session: SessionOf;
  readonly #sessionTeardown: SessionTeardown;

  constructor(session: SessionOf, sessionTeardown: SessionTeardown) {
    super();
    this.#session = session;
    this.#sessionTeardown = sessionTeardown;
  }

  /** The projects this session reaches, as catalog rows, oldest first: the projects of the orgs
   *  the user belongs to, with their role — narrowed to the projects a grant chose; for the admin
   *  secret, every project (no role). A grant bound to projects with no user lists them in the
   *  grant's order. Read fresh, past the isolate's memo: the dash reads it again when a fact says
   *  it changed. */
  list(): Promise<ProjectRecord[]> {
    return this.#session.input.controlPlane.reachableProjects(
      this.#session.authority.reach,
      [],
      true,
    );
  }

  /** The config repo templates this deployment was built with (scripts/build.ts: core/configs,
   *  default first, and any `--template`), which a creation may name; naming none creates
   *  core/configs/minimal. */
  async templates() {
    return templates;
  }

  /** Create the project named `project` (slugified into its hostname label; its id is minted —
   *  or, for the operator restoring a project seed, the archived `restoreProjectId` — the returned
   *  context's `whoami()` says it, so does `list()`) — in the organization named, or
   *  the user's own (the oldest when they have several, created on first use when they have
   *  none), or in the deployment's own for the admin secret — and vend its root context. The
   *  config repo template is PINNED to a commit here (a resumed creation always reads the same
   *  tree); the control plane refuses a slug ANY other organization holds (PROJECT_NAME_TAKEN),
   *  answers the same organization's again with the same project, and opens the project's own saga
   *  on its root (src/project/processor.ts seeds it from the template — the dash watches that
   *  facet's live state). Whoever creates it, `organization/project-added` then lands on its
   *  organization's activity, keyed by the project, so the same creation again (a project seed's
   *  `apply` converging an existing project) lands it once; an organization the creation minted
   *  gets its creation and its owner first. A grant narrowed to named projects creates none:
   *  FORBIDDEN. */
  async create(input: {
    project: string;
    orgId?: string;
    restoreProjectId?: string;
    configRepoTemplate?: string;
  }): Promise<IterateContextRpcTarget> {
    const data = z
      .object({
        project: z.string(),
        orgId: z.string().optional(),
        restoreProjectId: z.string().optional(),
        configRepoTemplate: z.string().transform(normalizeConfigRepoTemplateReference).optional(),
      })
      .parse(input);
    const { reach } = this.#session.authority;
    if (typeof reach === "object" && "projectIds" in reach)
      throw codedError(
        "FORBIDDEN",
        `this session is ${describeReach(reach)} — creating a project needs a signed-in user or the admin secret`,
      );
    const waits = new CreateWaits();
    let project: ProjectRecord | undefined;
    try {
      // pinned once, before the durable request: a resumed creation always reads the same tree
      const template = data.configRepoTemplate;
      const configRepoTemplate = template
        ? formatConfigRepoTemplateReference(
            await waits.time("template", () =>
              pinPublicGithubTemplate(parseConfigRepoTemplateReference(template)),
            ),
          )
        : undefined;
      const { input: sessionInput, caller } = this.#session;
      const created = await waits.time("controlPlaneCreate", () =>
        sessionInput.controlPlane.createProject(caller, {
          project: data.project,
          organizationId: data.orgId,
          restoreProjectId: data.restoreProjectId,
        }),
      );
      project = created;
      // The project's own creation saga, on its root: enable the `project` processor, then request
      // it — the saga (src/project/processor.ts) seeds the config repo from the template and lands
      // the certificate. Idempotent: a request after the certificate is a harmless fact, one after a
      // failure a new attempt. The dash watches the facet's live state; we return at once.
      const context = this.#context(created.id);
      await waits.time("projectEnable", () =>
        context.invoke(["itx", "processors", ["enable", "project"]]),
      );
      await waits.time("projectRequest", () =>
        context.invoke([
          "itx",
          [
            "append",
            {
              type: "events.iterate.com/project/create-requested",
              payload: { slug: created.slug, orgId: created.orgId, configRepoTemplate },
            },
          ],
        ]),
      );
      publishProjectAdded(sessionInput, created, caller);
      await waits.time("everyProjectLends", () =>
        borrowEveryProjectLends(sessionInput, created.id, caller),
      );
      return context;
    } finally {
      waits.report({ projectId: project?.id, orgId: project?.orgId });
    }
  }

  /** The project's root context ("/"), by its minted id (`prj_<hex>`) or its slug (a URL's
   *  `/projects/<slug>`, a hostname's label) — the control plane resolves either as it checks the
   *  reach (`reachableProjectId`), and the id alone goes on: the DO name's host, a grant's list,
   *  `whoami()`. A project only — a context name belongs to `cd`. Outside this session's reach is
   *  FORBIDDEN; so is the global namespace's id (it is no project: a platform admin reaches it as
   *  `session.global`). The admin secret alone addresses a project the catalog never heard of — by
   *  a `prj_…` id only (a fresh context of its own: the e2e suite's contexts); a slug the catalog
   *  does not hold is refused for every caller (control-plane/edge.ts `projectIdOf`). */
  async get(project: string): Promise<IterateContextRpcTarget> {
    const address = DurableObjectNameCodec.parse(project);
    if (address.path !== "/")
      throw new Error(
        `projects.get(project): got a context name ${JSON.stringify(project)} — pass the project and cd(path) from its root`,
      );
    if (address.projectId === GLOBAL_PROJECT_ID)
      throw codedError(
        "FORBIDDEN",
        `projects.get(${JSON.stringify(project)}): the deployment-global namespace is no project — a global context is reached by identity (session.user, session.organizations)`,
      );
    const { controlPlane } = this.#session.input;
    const { reach } = this.#session.authority;
    const id = await controlPlane.reachableProjectId(reach, address.projectId);
    if (!id)
      throw codedError(
        "FORBIDDEN",
        `projects.get(${JSON.stringify(project)}): outside this session's reach — ${describeReach(reach)}`,
      );
    return this.#context(id);
  }

  /** DELETE the project — the owner of its organization, or the operator. Every step is keyed, so
   *  a delete that failed part way is simply asked again: the control plane says who may (catalog.ts
   *  `projectToDelete`); the root is asked to delete it, as the platform's own fact; and the
   *  control plane drops its row, from which moment the edge admits no request to it (a root that
   *  is reached anyway refuses its birth: `#refuseBirthOfDeletedProjectRoot` in
   *  iterate-context-durable-object.ts), and then `organization/project-removed` lands on its
   *  organization's activity. The deletion saga on the root (project/processor.ts) destroys every
   *  context, its hostnames, kv, files and repos, and the root last, once the row is gone; the
   *  answer does not wait for it. */
  async delete(project: string): Promise<void> {
    const { input: sessionInput, caller } = this.#session;
    const address = DurableObjectNameCodec.parse(project);
    const id =
      address.path === "/" && address.projectId !== GLOBAL_PROJECT_ID
        ? await sessionInput.controlPlane.reachableProjectId(
            this.#session.authority.reach,
            address.projectId,
          )
        : null;
    if (!id)
      throw codedError("FORBIDDEN", `projects.delete(${JSON.stringify(project)}): no such project`);
    const doomed = await sessionInput.controlPlane.projectToDelete(caller, id);
    const root = sessionInput.contextNamespace.getByName(
      DurableObjectNameCodec.stringify({ projectId: id, path: "/" }),
    );
    await root.invoke(["itx", "builtins", "processors", ["enable", "project"]], [], caller);
    await root.invoke(
      [
        "itx",
        "builtins",
        [
          "append",
          {
            type: "events.iterate.com/project/delete-requested",
            idempotencyKey: "project/delete-requested",
            payload: {},
          },
        ],
      ],
      [],
      { ...caller, platform: true },
    );
    await sessionInput.controlPlane.deleteProject(caller, id);
    if (doomed.orgId !== ADMIN_ORG_ID)
      publishOrganizationFacts(sessionInput, caller, [
        [
          { organization: doomed.orgId },
          [
            {
              type: "events.iterate.com/organization/project-removed",
              idempotencyKey: `organization/project-removed:${id}`,
              payload: { projectId: id, slug: doomed.slug },
            },
          ],
        ],
      ]);
  }

  #context(projectId: string): IterateContextRpcTarget {
    this.#session.input.onProjectAccess?.(projectId);
    return new IterateContextRpcTarget(
      this.#session.input.contextNamespace,
      DurableObjectNameCodec.parse(projectId),
      this.#sessionTeardown,
      this.#session.input.waitUntil,
      this.#session.caller,
    );
  }
}

/** THE CONTEXT SWEEP (scripts/ci/context-sweep.ts): the contexts Cloudflare lists, by id — each
 *  says who it is from its own birth record (iterate-context-durable-object.ts `identity`), without
 *  recording a wake — and an orphan's backup and destruction: a context of a project the control
 *  plane no longer holds, which its project's deletion missed. */
class ContextSweepRpcTarget extends RpcTarget {
  readonly #session: SessionOf;
  constructor(session: SessionOf) {
    super();
    this.#session = session;
  }

  /** Who each id is — its project and path — or why it could not say. */
  async identify(
    ids: string[],
  ): Promise<({ id: string; projectId: string; path: string } | { id: string; error: string })[]> {
    return Promise.all(
      z
        .array(ContextObjectId)
        .parse(ids)
        .map(async (id) => {
          try {
            return { id, ...(await this.#byId(id).identity()) };
          } catch (error) {
            return { id, error: String(error).slice(0, 300) };
          }
        }),
    );
  }

  /** One page of the context `id`'s durable log, as `readEvents` pages it, read without a wake: the
   *  sweep backs an orphan up with it before destroying it. */
  async readEvents(id: string, afterOffset: number): Promise<StreamPage> {
    return this.#byId(id).readForSweep(z.number().int().nonnegative().parse(afterOffset));
  }

  /** Destroy the context `id`, an orphan: refused for a global context, and for one whose project
   *  the control plane still holds (its registry is the project deletion's to use). */
  async destroy(id: string): Promise<{ projectId: string; path: string }> {
    const stub = this.#byId(id);
    const { projectId, path } = await stub.identity();
    if (projectId === GLOBAL_PROJECT_ID)
      throw codedError("FORBIDDEN", `${path} is a global context: the sweep leaves it alone.`);
    // by id alone: the lookup also answers a slug, and a stray born under a live project's SLUG
    // (an operator addressing `templestein` as an id) is no part of that project. Fresh: a row this
    // isolate keeps may be of a project deleted through another one
    if ((await this.#session.input.controlPlane.getProject(projectId, true))?.id === projectId)
      throw codedError("FORBIDDEN", `${projectId} still exists: ${path} is no orphan.`);
    await stub.destroy().catch((error: unknown) => {
      if (!String(error).includes(CONTEXT_DESTROYED)) throw error;
    });
    return { projectId, path };
  }

  /** The context object Cloudflare lists as `id`, reached by that id alone. */
  #byId(id: string) {
    const namespace = this.#session.input.contextNamespace;
    return namespace.get(namespace.idFromString(ContextObjectId.parse(id)));
  }
}

/** A context object's id as Cloudflare lists it: 64 hex digits. */
const ContextObjectId = z.string().regex(/^[0-9a-f]{64}$/);

/** The people — the operator's catalog (`session.users` refuses everyone else): `list()`,
 *  `get(ref)` by id or email, `create({ email })` (find-or-create). */
class UserCollectionRpcTarget extends RpcTarget {
  readonly #session: SessionOf;
  constructor(session: SessionOf) {
    super();
    this.#session = session;
  }
  list(): Promise<UserRecord[]> {
    return this.#session.input.controlPlane.listUsers();
  }
  get(ref: string): Promise<UserRecord | null> {
    return this.#session.input.controlPlane.getUser(z.string().min(1).parse(ref));
  }
  async create(input: { email: string }): Promise<UserRecord> {
    const data = z.object({ email: z.string().trim().min(3) }).parse(input);
    return this.#session.input.controlPlane.createUser(data);
  }
}

/** WHAT THIS SESSION MUST UNDO AT ITS END — ONE entry per key: a lend relay (the session's copy of
 *  a client stub plus its pager socket, held so neither is GC'd) and anything else scoped to the
 *  session. THE CALLER OWNS THE KEY (iterate-context.ts `#sessionTeardownKey` pairs the context name
 *  with the stub key). Re-adding the SAME key is a TRANSPORT REPLACEMENT (a reconnect): by the time
 *  the new relay's pager is open, the DO has already dropped the old transport as "replaced", so
 *  disposing the incumbent here is a harmless double-close that keeps this map from accumulating
 *  dead relays. */
export class SessionTeardown {
  readonly #undoByKey = new Map<string, { dispose(): void }>();
  /** Register `undo` under `key`, REPLACING what sat there (disposed now). Returns the LEASE — the
   *  one thing a handle should hold: its dispose runs `undo` only while `undo` is still the current
   *  entry, so a stale handle (re-provide at the same match, then dispose the OLD handle) can never tear
   *  down its replacement. */
  add(key: string, undo: { dispose(): void }): { dispose(): void } {
    this.#undoByKey.get(key)?.dispose();
    this.#undoByKey.set(key, undo);
    return {
      dispose: () => {
        if (this.#undoByKey.get(key) !== undo) return; // replaced — the replacement owns the key now
        this.#undoByKey.delete(key);
        undo.dispose();
      },
    };
  }
  /** Dispose whatever sits under `key` now — the SESSION's own act (a `provide(match, null)`, a
   *  `subscribe` re-spelled as an expression), never a handle's. */
  dispose(key: string): void {
    const undo = this.#undoByKey.get(key);
    if (!undo) return;
    this.#undoByKey.delete(key);
    undo.dispose();
  }
  disposeAll(): void {
    for (const undo of this.#undoByKey.values()) undo.dispose();
    this.#undoByKey.clear();
  }
}

/** An invitation link's secret: 32 random bytes, base64url — the one path segment of
 *  `/invitations/<token>`, unguessable. The control plane keeps only its `sha256Hex` (`token_hash`),
 *  so a read of its database opens no organization; a plain digest suffices for 256 random bits. */
const mintInvitationToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
