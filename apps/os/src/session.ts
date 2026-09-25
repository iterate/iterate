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
} from "@iterate-com/shared/config-repo-template/reference";
import type { IterateApi } from "iterate/api";
import { codedError, reportIssue } from "iterate/lib";
import { OAuthScope } from "iterate/oauth-scopes";
import type { Principal } from "iterate/principal";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import { pinPublicGithubTemplate } from "./repo/github-template.ts";
import { base64url, sha256Hex, verifyAdminSecret, type Caller } from "./caller.ts";
import { templates } from "./generated/config-templates.js";
import type { ConsentRpcTarget } from "./consent.ts";
import type { GrantsRpcTarget } from "./grants.ts";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID } from "./context/paths.ts";
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
import { OrganizationRole, type OrganizationState } from "./organization/contract.ts";
import type { AppConfig } from "./app-config.ts";
import { isRetryableTransportError } from "./retryable-error.ts";
import type { AuthenticationFact } from "./account/contract.ts";
import { assertSecretPath } from "./secrets.ts";

/** What `IterateRpcTarget.authenticate` accepts. `from-server-cookie` is the browser and `bearer` is
 *  a device or script whose token rode the upgrade: the OAuth gate already resolved the session
 *  from the request, so either only says "hand me that session". Kit firmware (itx_mount.c) sends
 *  `{ type: "bearer" }` alone — the token-less form exists for it.
 *  `bearer` WITH a `token` is the in-band form (capnweb's own pattern): a client that opened the
 *  socket bare — a static page on another origin, whose browser cannot put a header on a WebSocket
 *  (api.ts) — presents its token here, and it goes through the same gate. `admin-secret` is the
 *  operator/CLI credential, verified in-band on any transport — a bare socket, or one the gate
 *  already resolved. */
const SessionCredentials = z.discriminatedUnion("type", [
  z.object({ type: z.literal("from-server-cookie") }),
  z.object({ type: z.literal("bearer"), token: z.string().min(1).optional() }),
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
  /** A live transport tracks projects whose capabilities it has handed out. */
  onProjectAccess?: (projectId: string) => void;
  /** The in-band bearer (rpc.ts): verify a token a bare socket presents and bind the transport to
   *  its grant — null for a token the gate refuses. Absent on an endpoint with no such form. */
  resolveBearer?: (token: string) => Promise<SessionAuthority | null>;
}

/** THE `/api` ROOT — the one thing a fresh capnweb connection holds. `authenticate(credentials)` is
 *  its only real verb: it returns the `SessionRpcTarget` you reach `.user`/`.projects`/… through.
 *  On a transport the OAuth gate resolved, `authenticate({ type: "from-server-cookie" })` hands back
 *  that session; a bare socket (api.ts) carries none, so it authenticates in-band —
 *  `authenticate({ type: "bearer", token })`, or `authenticate({ type: "admin-secret", secret })`,
 *  the deployment admin secret verified here.
 *  Its teardown owns every context the session it vends hands out. */
export class IterateRpcTarget extends RpcTarget {
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

  async authenticate(input: unknown): Promise<SessionRpcTarget> {
    const credentials = SessionCredentials.safeParse(input);
    if (!credentials.success)
      throw codedError(
        "INVALID_CREDENTIALS",
        "authenticate({ type }): 'from-server-cookie' (browser), 'bearer' (a token on the upgrade, or in-band as `token`) or 'admin-secret' (operator).",
      );
    if (credentials.data.type === "bearer" && credentials.data.token) {
      // IN-BAND: the same gate as a header on the upgrade, bound to this transport by rpc.ts. No
      // account fact — a page or script presenting its token on every reconnect is not a sign-in.
      const resolved = await this.#input.resolveBearer?.(credentials.data.token);
      if (!resolved) throw codedError("INVALID_CREDENTIALS", "Invalid or revoked bearer");
      return new SessionRpcTarget(this.#input, this.#sessionTeardown, resolved);
    }
    if (credentials.data.type === "from-server-cookie" || credentials.data.type === "bearer") {
      if (!this.#resolved)
        throw codedError("UNAUTHENTICATED", "this transport carries no session — sign in first.");
      // A person signing in is an account fact; a device or script presenting its token on every
      // reconnect is not (the grant's last use already records it) — so only the browser form
      // publishes one.
      if (credentials.data.type === "from-server-cookie")
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
        idempotencyKey: `authenticated/${operationId}`,
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
 *  (oauth.ts `accountStateOf`). */
export function ownerContext(contextNamespace: IterateContextNamespace, owner: FactOwner) {
  return contextNamespace.getByName(
    DurableObjectNameCodec.stringify({
      projectId: GLOBAL_PROJECT_ID,
      path: ownerAddress(owner).path,
    }),
  );
}

/** PLATFORM FACTS, appended to their owner's own context, awaited and throwing: the owner's
 *  processor row first (a second enable appends nothing), then the facts in ONE call, so they land
 *  in the order given. Stamped with the caller, principal and grant — the audit lives where it
 *  happened, attributed to who did it and through which connection — and with `source.platform`,
 *  the one thing the processor folding them trusts (a person can append any type to their own
 *  context; the platform's fixed point, which no rewrite rule redirects, is the only writer of the
 *  stamp). A grant's end (grants.ts, the revocation truth) and a grant's use (oauth.ts) await it;
 *  the organization verbs await it `folded` (`foldPlatformFacts`); the rest goes through
 *  `publishPlatformFacts`.
 *
 *  `folded` then waits on the owner's processor's read-your-writes barrier (`waitUntilProcessed`,
 *  which catches up from the log itself and rejects after its ten seconds) through the last fact's
 *  offset: the processor's push is asynchronous, so an append alone does not mean a read of the fold
 *  sees it.
 *
 *  THE CONTROL-PLANE DATABASE IS THE TRUTH; these facts are the fold the dash renders and the entity's
 *  activity, not the source of authority. Two CONCURRENT conflicting commands from different callers
 *  to the same context (a membership added and removed at once) have no ordering between them — the
 *  fold can settle opposite to the database's own order until the next authoritative read.
 *  Acceptable here: the edge authorizes every action against the database, never the fold. */
export async function appendPlatformFacts(
  contextNamespace: IterateContextNamespace,
  owner: FactOwner,
  facts: StreamEventInput | StreamEventInput[],
  caller: Caller,
  { folded = false }: { folded?: boolean } = {},
): Promise<void> {
  const context = ownerContext(contextNamespace, owner);
  const events = Array.isArray(facts) ? facts : [facts];
  const { processor } = ownerAddress(owner);
  await context.invoke(["itx", "processors", ["enable", processor]], [], caller);
  const appended = (await context.invoke(["itx", "builtins", ["append", ...events]], [], {
    ...caller,
    platform: true,
  })) as StreamEvent[];
  const offset = appended.at(-1)?.offset;
  if (folded && offset !== undefined)
    await context.invoke(
      ["itx", "facets", ["get", processor], ["waitUntilProcessed", { offset }]],
      [],
      caller,
    );
}

/** AN ORGANIZATION VERB'S FACTS — on the organization and on each member's account — appended and
 *  FOLDED before the verb answers. The control-plane database already decided the write; the answer
 *  now also means the folds hold it, so a caller's next read sees it and one caller's facts land in
 *  the order it made its calls. Fire-and-forget once let a cold organization context take a rename
 *  before the creation it renamed, and the fold kept the old name for good. A failed append fails
 *  the verb, loudly: the database's write stands (the same rename or membership again lands the
 *  same fact, which the fold absorbs), and the fold is never silently behind it. */
async function foldPlatformFacts(
  input: Pick<SessionInput, "contextNamespace">,
  landings: [FactOwner, StreamEventInput | StreamEventInput[]][],
  caller: Caller,
): Promise<void> {
  await Promise.all(
    landings.map(([owner, facts]) =>
      appendPlatformFacts(input.contextNamespace, owner, facts, caller, { folded: true }),
    ),
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

/** A PROJECT ON ITS ORGANIZATION'S RECORD — the fold the dash tree lists an organization's projects
 *  from (session-fed: the control-plane database is imperative). ONE path for every creation —
 *  a person's, the operator's acting as one, and the operator's own into a named organization (a
 *  project seed's `apply`) — and for a creation asked again: it lands what the record LACKS, read
 *  at head, so the same creation again (a rerun `apply`, a retry) appends nothing. An organization
 *  the record has never heard of is one this creation minted (a person's first project,
 *  catalog.ts): its creation and its members come first, in one ordered append, so the fold sees
 *  the organization before its project. Each of those memberships also lands on the member's
 *  account, in the BACKGROUND
 *  (`publishPlatformFacts`): the answer never waits on a person's account. A brand-new account's
 *  first write can take Cloudflare seconds to confirm (21.9 s on 2026-09-24), and its output gate
 *  holds every answer until then. Nothing before the answer needs the account: the dash reads it
 *  through live state, and every access check reads the control plane. Landing late, the
 *  membership may arrive after a later membership fact of the same organization, so it is marked
 *  `mint` and the account never lets it override one (account/processor.ts). The deployment's own
 *  organization (the operator's projects with no `orgId`) has no members and no page: nothing
 *  lands there.
 *
 *  TWO AT ONCE both read the record without it, so each fact lands under an idempotency key: the
 *  stream keeps the first event under a key and answers every later one with it. A minted
 *  organization's first members are keyed as that first landing (`:mint`), never as the membership
 *  itself, so a later removal and re-add is never swallowed. Only the platform takes an
 *  `organization/…` key (context/built-ins.ts `append`), so the event a key answers with is always
 *  one the fold keeps. */
async function landProjectOnOrganization(
  input: Pick<SessionInput, "contextNamespace" | "controlPlane" | "waitUntil">,
  project: ProjectRecord,
  caller: Caller,
  waits: CreateWaits,
): Promise<void> {
  if (project.orgId === ADMIN_ORG_ID) return;
  // The record at head (the facet catches up from its log before answering), its processor enabled
  // first: an organization this creation just minted has no row yet, and a second enable appends
  // nothing. `invoke` answers `unknown` across the DO hop; the `organization` facet is the
  // platform's own OrganizationDurableObject and `snapshot()` the engine's `{ offset, state }`.
  const organizationContext = ownerContext(input.contextNamespace, { organization: project.orgId });
  await waits.time("organizationEnable", () =>
    organizationContext.invoke(["itx", "processors", ["enable", "organization"]], [], caller),
  );
  const { state: record } = (await waits.time("organizationSnapshot", () =>
    organizationContext.invoke(
      ["itx", "facets", ["get", "organization"], ["snapshot"]],
      [],
      caller,
    ),
  )) as { state: OrganizationState };
  const onOrganization: StreamEventInput[] = [];
  if (!record.name) {
    const organization = await waits.time("controlPlaneOrganization", () =>
      input.controlPlane.getOrganization(project.orgId),
    );
    const members = await waits.time("controlPlaneMembers", () =>
      input.controlPlane.listMembers(project.orgId),
    );
    onOrganization.push({
      ...orgCreatedFact(organization?.name ?? project.orgId),
      idempotencyKey: "organization/created",
    });
    for (const { userId, role } of members) {
      if (record.members[userId]?.role === role) continue;
      const membership = {
        ...memberAddedFact(project.orgId, userId, role, { mint: true }),
        idempotencyKey: `organization/member-added:${project.orgId}:${userId}:mint`,
      };
      onOrganization.push(membership);
      publishPlatformFacts(input, { account: userId }, membership, caller);
    }
  }
  // a project is created once and its slug never changes: every landing of it is the same event
  if (!record.projects[project.id])
    onOrganization.push({
      ...projectAddedFact(project.id, project.slug),
      idempotencyKey: `organization/project-added:${project.id}`,
    });
  if (onOrganization.length)
    await waits.time("organizationFold", () =>
      foldPlatformFacts(input, [[{ organization: project.orgId }, onOrganization]], caller),
    );
}

/** `appendPlatformFacts` best-effort and ASYNC (waitUntil), off the verb's own path: the account's
 *  sign-ins, mints and consents — facts no answer depends on. A lost fact is a gap in the record,
 *  never a failed action. A deploy resetting the
 *  owner's Durable Object cuts in-flight appends at the transport (retryable-error.ts) — expected on
 *  every deploy under traffic, so a warning; any other failure is reported, as oauth.ts reports a
 *  grant use it could not record. */
export function publishPlatformFacts(
  input: Pick<SessionInput, "contextNamespace" | "waitUntil">,
  owner: FactOwner,
  facts: StreamEventInput | StreamEventInput[],
  caller: Caller,
): void {
  input.waitUntil(
    appendPlatformFacts(input.contextNamespace, owner, facts, caller).catch((error) => {
      const attributes = {
        path: ownerAddress(owner).path,
        types: [facts]
          .flat()
          .map((fact) => fact.type)
          .join(","),
      };
      if (isRetryableTransportError(error)) {
        console.warn({
          event: "session.platform-fact-cut",
          ...attributes,
          message: String(error),
        });
        return;
      }
      reportIssue("session.platform-fact-not-recorded", error, attributes);
    }),
  );
}

/** The organization's facts, built once (the same membership fact rides the organization's context
 *  and the member's account). Their shapes are the organization contract's (src/organization/). */
const orgCreatedFact = (name: string): StreamEventInput => ({
  type: "events.iterate.com/organization/created",
  payload: { name },
});
const orgRenamedFact = (name: string): StreamEventInput => ({
  type: "events.iterate.com/organization/renamed",
  payload: { name },
});
const orgDeletedFact = (): StreamEventInput => ({
  type: "events.iterate.com/organization/deleted",
  payload: {},
});
const memberAddedFact = (
  orgId: string,
  userId: string,
  role: OrganizationRole,
  { mint }: { mint?: true } = {},
): StreamEventInput => ({
  type: "events.iterate.com/organization/member-added",
  payload: { orgId, userId, role, mint },
});
const memberRemovedFact = (orgId: string, userId: string): StreamEventInput => ({
  type: "events.iterate.com/organization/member-removed",
  payload: { orgId, userId },
});
const invitationCreatedFact = (invitation: InvitationRecord): StreamEventInput => ({
  type: "events.iterate.com/organization/invitation-created",
  payload: {
    invitationId: invitation.id,
    role: invitation.role,
    emailHint: invitation.emailHint,
    expiresAt: invitation.expiresAt,
  },
});
const invitationAcceptedFact = (invitationId: string, userId: string): StreamEventInput => ({
  type: "events.iterate.com/organization/invitation-accepted",
  payload: { invitationId, userId },
});
const invitationRevokedFact = (invitationId: string): StreamEventInput => ({
  type: "events.iterate.com/organization/invitation-revoked",
  payload: { invitationId },
});
const projectAddedFact = (projectId: string, slug: string): StreamEventInput => ({
  type: "events.iterate.com/organization/project-added",
  payload: { projectId, slug },
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

  /** The deploy's readiness gate's (scripts/preview-readiness.ts), the operator's alone: the version
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
    return {
      principal: this.#authority.principal,
      grant: this.#authority.grant,
      platformOrigin: this.#input.platformOrigin,
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

  /** THE GLOBAL NAMESPACE'S ROOT `/`, for a platform admin: a context is (namespace, path), the
   *  namespace a project or the global one, and this handle's `cd` walks the global namespace as a
   *  project's walks its project — `global.cd("/users/<id>")`, `/organizations/<id>…`
   *  (iterate-context.ts). For a person holding the `admin` scope (reach `every` only while
   *  `admins` lists them, oauth.ts) alone: not the operator bearer, which names no person, and not
   *  anyone else, whose global contexts stay reached by identity (`user`, `organizations.get`). */
  get global(): IterateContextRpcTarget {
    const { principal, reach, scopes } = this.#authority;
    if (reach !== "every" || !principal.email || !scopes?.includes("admin"))
      throw codedError("FORBIDDEN", "Only a platform admin opens the global namespace.");
    return this.#globalContext("/", true);
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

/** The organization catalog. `list()` is the person's organizations, with their role (a grant
 *  narrowed to projects sees only the organizations those projects belong to — unless it holds
 *  `organizations:write`, which is the organizations themselves); `get(orgId)` vends the
 *  organization's context BY MEMBERSHIP (an org the session does not reach is FORBIDDEN, exactly as
 *  `projects.get` outside its reach); `create`, `rename`, `delete`, `addMember`, `removeMember`,
 *  `createInvitation`, `revokeInvitation` and `acceptInvitation` are each one call on the control
 *  plane under this caller, which checks the rest (an owner? the last owner? projects still held?
 *  a link still open?) against its catalog. */
class OrganizationCollectionRpcTarget extends RpcTarget {
  readonly #session: SessionOf;
  constructor(session: SessionOf) {
    super();
    this.#session = session;
  }

  /** The organizations this session reaches, narrowed as the docstring says. `fresh` re-reads the
   *  person's memberships past the isolate's memo — the re-read before a refusal (edge.ts's rule),
   *  so a membership that just landed elsewhere is admitted at once. */
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

  list(): Promise<OrganizationRecord[]> {
    return this.#reachable();
  }

  async get(orgId: string): Promise<IterateContextRpcTarget> {
    // ONE path segment — the catalog's `org_<hex>` — never a path: the id is interpolated into
    // `/organizations/<id>`, and `..` or `x/../users/<id>` would canonicalize onto another global
    // context (the admin reaches every org, so the membership check alone would not catch it).
    const id = z.string().trim().min(1).parse(orgId);
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw codedError(
        "FORBIDDEN",
        `organizations.get(${JSON.stringify(id)}): an organization id is one path segment, never a path`,
      );
    // BY MEMBERSHIP, AS `list()` NARROWS IT: a grant bound to projects reaches only the organizations
    // those projects belong to (unless it holds `organizations:write`), so a personal access token
    // opens no other organization's context. The admin reaches every one. A miss is re-read once
    // past the memo before it is refused: a membership that just landed is admitted at once.
    const reaches = (organizations: OrganizationRecord[]) =>
      organizations.some((organization) => organization.id === id);
    const reachable =
      this.#session.authority.reach === "every" ||
      reaches(await this.#reachable()) ||
      reaches(await this.#reachable(true));
    if (!reachable)
      throw codedError(
        "FORBIDDEN",
        `organizations.get(${JSON.stringify(id)}): not an organization this session belongs to`,
      );
    return this.#session.globalContext(`/organizations/${id}`);
  }

  /** An organization's members with their emails — the operator's alone (the project-seed CLI
   *  captures an organization's membership with the project). */
  async members(orgId: string): Promise<MemberRecord[]> {
    if (this.#session.authority.reach !== "every")
      throw codedError("FORBIDDEN", "Only the operator lists an organization's members.");
    return this.#session.input.controlPlane.listMembers(z.string().min(1).parse(orgId));
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
    // Land the organization on its own context (the fold the dash renders); the owner's membership
    // rides there — after the creation, in one ordered append — and on their account. The operator's
    // scripts add members themselves (an owner named by the operator gets no session here).
    if (record.role === "owner") {
      const membership = memberAddedFact(record.id, caller.principal!.actor, "owner");
      await foldPlatformFacts(
        sessionInput,
        [
          [{ organization: record.id }, [orgCreatedFact(record.name), membership]],
          [{ account: caller.principal!.actor }, membership],
        ],
        caller,
      );
    } else
      await foldPlatformFacts(
        sessionInput,
        [[{ organization: record.id }, orgCreatedFact(record.name)]],
        caller,
      );
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
    await foldPlatformFacts(
      sessionInput,
      [[{ organization: organizationId }, orgRenamedFact(record.name)]],
      caller,
    );
    return { ...record, role: "owner" };
  }

  /** Delete an organization the person owns, while it holds no project. The deletion lands on the
   *  organization's own context, and each membership ends on the member's account. */
  async delete(orgId: string): Promise<void> {
    this.#session.organizationsWriter("delete");
    const { input: sessionInput, caller } = this.#session;
    const organizationId = z.string().min(1).parse(orgId);
    // The members, read before the delete refuses or succeeds — to end their memberships below.
    const members = await sessionInput.controlPlane.listMembers(organizationId);
    await sessionInput.controlPlane.deleteOrganization(caller, organizationId);
    await foldPlatformFacts(
      sessionInput,
      [
        ...members.map(({ userId }): [FactOwner, StreamEventInput] => [
          { account: userId },
          memberRemovedFact(organizationId, userId),
        ]),
        [{ organization: organizationId }, orgDeletedFact()],
      ],
      caller,
    );
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
    await foldPlatformFacts(
      sessionInput,
      [
        [{ organization: organizationId }, fact],
        [{ account: userId }, fact],
      ],
      caller,
    );
  }

  /** Remove a person from an organization the caller owns. */
  async removeMember(orgId: string, input: { userId: string }): Promise<void> {
    this.#session.organizationsWriter("remove a member from");
    const data = z.object({ userId: z.string().min(1) }).parse(input);
    const { input: sessionInput, caller } = this.#session;
    const organizationId = z.string().min(1).parse(orgId);
    const userId = await sessionInput.controlPlane.removeMember(caller, organizationId, data);
    const fact = memberRemovedFact(organizationId, userId);
    await foldPlatformFacts(
      sessionInput,
      [
        [{ organization: organizationId }, fact],
        [{ account: userId }, fact],
      ],
      caller,
    );
  }

  /** A new INVITATION LINK to an organization the caller owns: whoever signs in and accepts it
   *  first joins in `role` (default member), until it expires (`expiresInDays`, default 7, at most
   *  30). Answers the invitation with its `token` — the link's secret, shown this once (the
   *  control plane keeps only its SHA-256); the dash puts it in `/invitations/<token>`. The
   *  organization's record lists it as pending until it is accepted or revoked. `emailHint` is who
   *  it is meant for, a note for the owners — never checked against who accepts. */
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
    await foldPlatformFacts(
      sessionInput,
      [[{ organization: organizationId }, invitationCreatedFact(invitation)]],
      caller,
    );
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
    await foldPlatformFacts(
      sessionInput,
      [[{ organization: organizationId }, invitationRevokedFact(data.invitationId)]],
      caller,
    );
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
    // landed again on a retry by the same person: the fold absorbs both, and `role` is the
    // membership as it stands, so a promotion since is never rewound
    if (accepted) {
      const membership = memberAddedFact(invitation.orgId, userId, role);
      await foldPlatformFacts(
        sessionInput,
        [
          [
            { organization: invitation.orgId },
            [invitationAcceptedFact(invitation.id, userId), membership],
          ],
          [{ account: userId }, membership],
        ],
        caller,
      );
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

  /** The projects this session reaches, as catalog rows: the projects of the orgs the user
   *  belongs to, with their role — narrowed to the projects a grant chose; for the admin secret,
   *  every project (no role). */
  list(): Promise<ProjectRecord[]> {
    return this.#session.input.controlPlane.reachableProjects(this.#session.authority.reach);
  }

  /** The built-in config repo templates a creation may name (generated/config-templates.js); naming
   *  none creates the default config (configs/default). */
  async templates() {
    return templates;
  }

  /** Create the project named `project` (slugified into its hostname label; its id is minted —
   *  or, for the operator restoring a project seed, the archived `restoreProjectId` — the returned
   *  context's `whoami()` says it, so does `list()`) — in the organization named, or
   *  the user's own (the first by name when they have several, created on first use when they
   *  have none), or in the deployment's own for the admin secret — and vend its root context. The
   *  config repo template is PINNED to a commit here (a resumed creation always reads the same
   *  tree); the control plane refuses a slug ANY other organization holds (PROJECT_NAME_TAKEN),
   *  answers the same organization's again with the same project, and opens the project's own saga
   *  on its root (src/project/processor.ts seeds it from the template — the dash watches that
   *  facet's live state). Whoever creates it, the project then lands on its organization's record,
   *  which the dash lists (`landProjectOnOrganization`); the same creation again lands nothing
   *  twice, so a project seed's `apply` converges an existing project through this same call. A
   *  grant narrowed to named projects creates none: FORBIDDEN. */
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
      // The organization's record, before the answer: the dash lists the project as soon as it has
      // it. The member's account is not waited on.
      await landProjectOnOrganization(sessionInput, created, caller, waits);
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
   *  `session.global`). The admin secret alone addresses a project the catalog never heard of, by
   *  id (a fresh context of its own). */
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
   *  `projectToDelete`); the root is asked to delete it, as the platform's own fact; the project
   *  leaves its organization's record; and the control plane drops its row, from which moment
   *  nothing reaches it. The deletion saga on the root (project/processor.ts) destroys every
   *  context, its hostnames, kv, files and repos, and the root last; the answer does not wait for
   *  it. */
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
    await root.invoke(["itx", "processors", ["enable", "project"]], [], caller);
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
    if (doomed.orgId !== ADMIN_ORG_ID)
      await appendPlatformFacts(
        sessionInput.contextNamespace,
        { organization: doomed.orgId },
        {
          type: "events.iterate.com/organization/project-removed",
          idempotencyKey: `organization/project-removed:${id}`,
          payload: { projectId: id, slug: doomed.slug },
        },
        caller,
        { folded: true },
      );
    await sessionInput.controlPlane.deleteProject(caller, id);
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

// THE PUBLISHED API IS DECLARED, NOT GENERATED (iterate/api): this root satisfies it, checked here.
const _iterateApi: IterateApi = null as unknown as IterateRpcTarget;
void _iterateApi;

/** An invitation link's secret: 32 random bytes, base64url — the one path segment of
 *  `/invitations/<token>`, unguessable. The control plane keeps only its `sha256Hex` (`token_hash`),
 *  so a read of its database opens no organization; a plain digest suffices for 256 random bits. */
const mintInvitationToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
