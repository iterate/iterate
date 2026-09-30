import {
  AuthorizationError,
  CimdFetchError,
  type AuthRequest,
  type ClientInfo,
} from "@cloudflare/workers-oauth-provider";
import { RpcTarget } from "capnweb";
import { z } from "zod";
import { codedError } from "iterate/lib";
import {
  OAuthScope,
  OAuthScopeDescriptions,
  OAuthScopes,
  type ConsentScope,
} from "iterate/oauth-scopes";
import type { IngressRouting } from "iterate/project-ingress";
import { suggestOrganizationName } from "./name-suggestions.ts";
import { type ConsentApproved, type Impersonation } from "./account/contract.ts";
import type { Env } from "./env.ts";
import type { OrganizationRecord, ProjectRecord, UserRecord } from "./control-plane/catalog.ts";
import { ControlPlane } from "./control-plane/edge.ts";
import { appConfigOf, type PlatformAddresses } from "./app-config.ts";
import {
  grantIsLive,
  isAdmin,
  oauthHelpers,
  parseAuthorization,
  type AccessGrant,
  type GrantProps,
} from "./oauth.ts";
import { clientDisplay } from "./client-display.ts";
import { appendPlatformFacts, publishPlatformFacts } from "./session.ts";

export type ConsentView =
  | {
      kind: "consent";
      query: string;
      clientName: string;
      /** The OAuth client id, independently of the app-supplied display name and logo. */
      clientId: string;
      clientLogoUri?: string;
      /** CIMD's metadata host, otherwise the registered client's self-declared website host. */
      clientDomain?: string;
      email: string;
      /** the identity provider's picture of the signed-in person, when the sign-in brought one */
      picture?: string;
      projects: ProjectRecord[];
      orgs: OrganizationRecord[];
      projectBound: boolean;
      /** the scopes the request asked for, each with the page's copy (oauth-scopes.ts) */
      scopes: ConsentScope[];
      denyLocation: string;
      /** how projects are reached over HTTP (project-ingress.ts) — the New project form's hint
       *  composes `<slug>.<hostname>` or `<origin>/projects/<slug>/` from it; null when this deployment
       *  serves no project ingress */
      ingressRouting: IngressRouting;
      /** the onboarding step's first draft of an organization name: from the person's display name,
       *  else their email's company domain or local part */
      suggestedOrganizationName: string;
      /** For a platform admin only: what "Sign in as someone else…" offers and must show before
       *  it signs the client in as someone (`approve`'s `impersonate`, `#impersonate`). */
      impersonation?: {
        /** everyone else on the platform */
        people: UserRecord[];
        /** what the grant would hold: the request's scopes but `admin` */
        scopes: ConsentScope[];
        resource: "API" | "MCP";
        /** where the authorization code goes */
        redirectHost: string;
        /** CIMD's metadata host — the one verified fact of who the client is; none for a client
         *  that registered itself */
        metadataHost?: string;
        /** one of this deployment's own apps, as far as the issuer can tell (`isOwnApp`) */
        ownApp: boolean;
        /** THE PERSON A LINK NAMED: the authorization's `login_hint` (iterate/app-server.ts
         *  `/.auth/login`; a PR body's `Sign in ↗`, scripts/os/preview.ts), when it is one of `people`
         *  under the test email domain (`login.testEmailDomain`, none on prd) and the client one of
         *  our own apps. The page opens on "Sign in as someone else" with
         *  them filled in, and the admin still confirms: `approve` never reads the hint, only the
         *  page's own post. */
        suggested?: string;
      };
    }
  | {
      /** a client asking only who the person is (the `/oauth2/userinfo` resource, `#identify`) */
      kind: "identify";
      clientName: string;
      clientId: string;
      clientLogoUri?: string;
      clientDomain?: string;
      /** the person, signed in: what the client will learn */
      email: string;
      denyLocation: string;
    }
  | { kind: "redirect"; location: string }
  | { kind: "invalid"; description: string };

/** A platform-served project CIMD client can receive only that project's authority — its
 *  client.json on a project host (control-plane/edge.ts `projectHostOf`, as the edge admits one).
 *  `expected` are the ids the caller refuses without — approve's ticked projects, re-read past
 *  what the isolate keeps of their access before one is left out (edge.ts `reachableProjects`). */
export async function projectsForClient(
  env: Env,
  platformOrigin: string,
  clientId: string,
  userId: string,
  expected: readonly string[] = [],
) {
  const controlPlane = new ControlPlane(env);
  const projects = await controlPlane.reachableProjects({ userId }, expected);
  const url = URL.canParse(clientId) ? new URL(clientId) : null;
  const host =
    url?.pathname === "/.auth/client.json"
      ? await controlPlane.projectHostOf(appConfigOf(env), url, platformOrigin)
      : null;
  if (!host) return { projects, projectBound: false };
  const project = await controlPlane.getProject(host.project);
  return { projects: projects.filter((p) => p.id === project?.id), projectBound: true };
}

/** How long a userinfo grant (`kind: "identify"`) lives: the client reads who signed in once, at
 *  once, and revokes it (admin-sign-in.ts); ten minutes bounds one it never revoked. */
const IDENTIFY_GRANT_MS = 10 * 60_000;

/** The host of a CIMD client id (`https://<host>/…`, its metadata document's URL): the one fact of
 *  who a client is that the platform verified, by fetching it there. */
function cimdHostOf(clientId: string) {
  const url = URL.canParse(clientId) ? new URL(clientId) : null;
  return url?.protocol === "https:" ? url.host : undefined;
}

/** Whether a client is one of this deployment's own apps, as far as the issuer can tell: the app
 *  SDK's CIMD document (`/.auth/client.json`, iterate/app-server.ts) on a sibling of the platform's
 *  host — dash.iterate.com beside os.iterate.com, a preview's `pr1-dash` beside its `pr1-os` —
 *  and not a project's host, which is userspace. On a laptop's platform every app returning to the
 *  laptop counts: a local app registers itself (iterate/app-session.ts), and nothing there is
 *  anyone's real data. It grants nothing: the impersonation confirm's warning reads it, and
 *  whether a link may pre-fill that confirm (`#impersonation`). */
function isOwnApp(request: AuthRequest, platformOrigin: string, projectBound: boolean) {
  if (projectBound) return false;
  const loopback = (url: string) => ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
  if (loopback(platformOrigin)) return loopback(request.redirectUri);
  const url = URL.canParse(request.clientId) ? new URL(request.clientId) : null;
  if (url?.protocol !== "https:" || url.pathname !== "/.auth/client.json") return false;
  const parentOf = (hostname: string) => hostname.slice(hostname.indexOf(".") + 1);
  return parentOf(url.hostname) === parentOf(new URL(platformOrigin).hostname);
}

/** The grant an approval minted: `completeAuthorization` stores it before it answers, and its code
 *  is `<userId>:<grantId>:<secret>` (@cloudflare/workers-oauth-provider; this issuer offers no
 *  implicit flow, so the code always rides the redirect's query). */
function grantIdOf(approved: { redirectTo: string }) {
  const grantId = new URL(approved.redirectTo).searchParams.get("code")?.split(":")[1];
  if (!grantId) throw new Error("The authorization code names no grant.");
  return grantId;
}

/** Expected OAuth refusals retain the validated client redirect when one exists. */
function authorizationFailure(
  error: unknown,
): Extract<ConsentView, { kind: "redirect" | "invalid" }> {
  if (error instanceof CimdFetchError)
    return {
      kind: "invalid",
      description: "The client metadata could not be loaded or validated.",
    };
  if (!(error instanceof AuthorizationError)) throw error;
  if (!error.redirectUri) return { kind: "invalid", description: error.description };
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return { kind: "redirect", location: redirect.href };
}

/** This capability exists only on the grant minted by verified issuer sign-in.
 * Account scope and a copied issuer client ID never confer approval authority. */
export class ConsentRpcTarget extends RpcTarget {
  readonly #env: Env;
  readonly #ctx: ExecutionContext;
  readonly #grant: AccessGrant;
  /** where this session reached the platform (app-config.ts `platformAddressesOf`) */
  readonly #addresses: PlatformAddresses;
  /** Whether this target serves one call of the request whose own admission just read the grant
   *  live (consent-page.server.ts, `browserAuthorization`), rather than a session (rpc.ts). */
  readonly #admittedThisRequest: boolean;
  constructor(
    env: Env,
    ctx: ExecutionContext,
    grant: AccessGrant,
    addresses: PlatformAddresses,
    { admittedThisRequest }: { admittedThisRequest: boolean },
  ) {
    super();
    if (grant.kind !== "issuer")
      throw codedError("FORBIDDEN", "Sign in to iterate to approve access.");
    this.#env = env;
    this.#ctx = ctx;
    this.#grant = grant;
    this.#addresses = addresses;
    this.#admittedThisRequest = admittedThisRequest;
  }
  async #request(query: unknown) {
    // Issuing a new grant must not spend the live transport's revocation grace: a session's consent
    // outlives the admission that made it (a socket's while it is open, a batch's behind the calls
    // before it), so it reads the grant again. The consent page's request (consent-page.server.ts)
    // read the account afresh to admit the grant just before this call, and reads it no second time.
    if (!this.#admittedThisRequest && !(await grantIsLive(this.#env, this.#grant)))
      throw codedError("UNAUTHENTICATED", "This session has ended. Sign in again.");
    const search = z.string().parse(query).replace(/^\?/, "");
    return parseAuthorization(
      this.#env,
      new Request(`${this.#addresses.platformOrigin}/oauth2/auth?${search}`),
    );
  }
  async describe(query: string): Promise<ConsentView> {
    const env = this.#env;
    try {
      const request = await this.#request(query);
      const client = await oauthHelpers(env, this.#addresses).lookupClient(request.clientId);
      const identify = request.resource === this.#addresses.userinfo;
      const display = clientDisplay(client, request.clientId);
      const denied = new URL(request.redirectUri);
      denied.searchParams.set("error", "access_denied");
      denied.searchParams.set("error_description", "The user declined access.");
      if (request.state) denied.searchParams.set("state", request.state);
      if (request.issuer) denied.searchParams.set("iss", request.issuer);
      if (identify)
        return {
          kind: "identify",
          clientName: display.clientName,
          clientId: request.clientId,
          clientLogoUri: display.logoUri,
          clientDomain: display.clientDomain,
          email: this.#grant.email,
          denyLocation: denied.href,
        };
      // The page lists what the person holds NOW, read past what this isolate keeps of their
      // access: a project just made (the page's New project form, served by whichever isolate) is
      // listed at once. The project list below reads the answer this read just kept.
      const controlPlane = new ControlPlane(env);
      const { organizations } = await controlPlane.accessibleTo(this.#grant.userId, true);
      const bound = await projectsForClient(
        env,
        this.#addresses.platformOrigin,
        request.clientId,
        this.#grant.userId,
      );
      return {
        kind: "consent",
        query,
        denyLocation: denied.href,
        clientName: display.clientName,
        clientId: request.clientId,
        clientLogoUri: display.logoUri,
        clientDomain: display.clientDomain,
        email: this.#grant.email,
        picture: this.#grant.picture,
        // parseAuthorization admitted only known scopes
        scopes: this.#grantable(request, bound.projectBound).map((scope) => {
          const name = OAuthScope.parse(scope);
          return { name, ...OAuthScopeDescriptions[name] };
        }),
        orgs: organizations,
        ingressRouting: appConfigOf(env).urls.ingressRouting,
        suggestedOrganizationName: suggestOrganizationName({
          name: this.#grant.name,
          email: this.#grant.email,
        }),
        ...bound,
        ...(isAdmin(env, this.#grant.email) && {
          impersonation: await this.#impersonation(request, query, bound.projectBound),
        }),
      };
    } catch (error) {
      return authorizationFailure(error);
    }
  }

  /** What an admin's "Sign in as someone else…" offers for `request` (`ConsentView`'s
   *  `impersonation`), `query` its raw authorization query. */
  async #impersonation(request: AuthRequest, query: string, projectBound: boolean) {
    const people = (await new ControlPlane(this.#env).listUsers()).filter(
      (user) => user.id !== this.#grant.userId,
    );
    const ownApp = isOwnApp(request, this.#addresses.platformOrigin, projectBound);
    // a link pre-fills only a test person (a PR body's `pr<N>@…`), and only for one of our apps:
    // prd has no test email domain, so there, like for a third party, the choice stays the admin's
    const testEmailDomain = appConfigOf(this.#env).login.testEmailDomain;
    const hint = new URLSearchParams(query).get("login_hint")?.trim().toLowerCase();
    const named = ownApp && testEmailDomain && hint?.endsWith(`@${testEmailDomain}`);
    return {
      people,
      scopes: request.scope
        .filter((scope) => scope !== "admin")
        .map((scope) => {
          const name = OAuthScope.parse(scope);
          return { name, ...OAuthScopeDescriptions[name] };
        }),
      resource: request.resource === this.#addresses.mcp ? "MCP" : "API",
      redirectHost: new URL(request.redirectUri).host,
      metadataHost: cimdHostOf(request.clientId),
      ownApp,
      suggested: named ? people.find((person) => person.email === hint)?.email : undefined,
    } satisfies Extract<ConsentView, { kind: "consent" }>["impersonation"];
  }

  /** Approve: the projects ticked (`["*"]` = every current and future project) and, task-based
   *  consent, the scopes left ticked — `iterate` always, never one the request did not ask for; the
   *  grant and its tokens carry exactly that set (`session.info().scopes` tells the app). Without
   *  `scopes`, the request's whole set. With `impersonate` (a person's user id, the page's "Sign in
   *  as someone else…"), a platform admin signs the client in as that person instead
   *  (`#impersonate`); anyone else is refused, whatever the page showed them. The admin is never
   *  read from the input: only from this target's live issuer grant. */
  async approve(input: {
    query: string;
    projects: string[];
    scopes?: string[];
    impersonate?: string;
  }): Promise<{ redirectTo: string } | { error: string }> {
    const env = this.#env;
    const data = z
      .object({
        query: z.string(),
        projects: z.array(z.string()),
        scopes: z.array(z.string()).optional(),
        impersonate: z.string().startsWith("user_").optional(),
      })
      .parse(input);
    try {
      const request = await this.#request(data.query);
      const client = await oauthHelpers(env, this.#addresses).lookupClient(request.clientId);
      if (request.resource === this.#addresses.userinfo) {
        if (data.impersonate)
          return { error: "Signing in as someone else is not for this client." };
        return await this.#complete(request, client, [], ["iterate"], IDENTIFY_GRANT_MS);
      }
      if (data.impersonate) return await this.#impersonate(request, client, data.impersonate);
      const { projects, projectBound } = await projectsForClient(
        env,
        this.#addresses.platformOrigin,
        request.clientId,
        this.#grant.userId,
        data.projects.filter((project) => project !== "*"),
      );
      const checked = new Set(data.projects);
      const granted = projects.filter((p) => checked.has(p.id)).map((p) => p.id);
      const allProjects = !projectBound && checked.has("*");
      if (!allProjects && !granted.length)
        return { error: "Choose at least one project you can access." };
      const grantable = this.#grantable(request, projectBound);
      const scope = OAuthScopes.parse(
        (data.scopes || grantable).filter(
          (candidate) => grantable.includes(candidate) && OAuthScope.safeParse(candidate).success,
        ),
      );
      return await this.#complete(request, client, allProjects ? null : granted, scope);
    } catch (error) {
      const failure = authorizationFailure(error);
      return failure.kind === "redirect"
        ? { redirectTo: failure.location }
        : { error: failure.description };
    }
  }

  /** The scopes of `request` this person may grant: all it asked for, but `admin` only to a
   *  platform admin (app-config.ts `admins`), only for `/api` and never for a client bound to one
   *  project — on a project host an admin's grant would count as a member of every project. */
  #grantable(request: AuthRequest, projectBound: boolean): string[] {
    const admin =
      isAdmin(this.#env, this.#grant.email) &&
      !projectBound &&
      request.resource === this.#addresses.api;
    return request.scope.filter((scope) => admin || scope !== "admin");
  }

  /** SIGN IN AS SOMEONE ELSE: a platform admin's approval of any authorization — a first-party
   *  app's or a third party's, for `/api` or `/mcp` — as the person `userId` names; refused to anyone
   *  the platform's `admins` does not list (the page offers it to no one else, but a form can be
   *  posted by hand) and for an address nobody signed in as. The client gets a grant of the
   *  PERSON — stored under them, so it is in their Sessions, marked with the admin — that reaches
   *  exactly what theirs would (every project of theirs, the scopes the client asked for but
   *  `admin`), with the admin beside them on every call it makes (`impersonatedBy`, oauth.ts). An
   *  hour, never refreshed past it; ended at once if the admin leaves `admins`. The person's own
   *  grants stay: `revokeExistingGrants`' default would sign them out. The code reaches the client
   *  only once both accounts record the grant, AWAITED: the person's that it started, the admin's
   *  that they did it. A record that fails leaves the code unsent, and the grant unexchanged dies
   *  with the code's ten minutes. */
  async #impersonate(request: AuthRequest, client: ClientInfo | null, userId: string) {
    const env = this.#env;
    if (!isAdmin(env, this.#grant.email))
      return { error: "Only a platform admin can sign in as someone else." };
    const target = await new ControlPlane(env).getUser(userId);
    if (!target) return { error: "Nobody on this platform has that id." };
    const impersonatedBy = { actor: this.#grant.userId, email: this.#grant.email };
    const scope = request.scope.filter((scope) => scope !== "admin");
    // bound as the person's own grant for this client would be: a project host's client reaches
    // that one project (`projectsForClient`), never the rest of their work
    const { projects, projectBound } = await projectsForClient(
      env,
      this.#addresses.platformOrigin,
      request.clientId,
      target.id,
    );
    if (projectBound && !projects.length)
      return { error: `${target.email} cannot reach this project.` };
    const deadline = Date.now() + 3600_000;
    const display = clientDisplay(client, request.clientId);
    const approved = await oauthHelpers(env, this.#addresses).completeAuthorization({
      request,
      userId: target.id,
      // the person's Sessions list shows who started it (grants.ts)
      metadata: { ...display, impersonatedBy: impersonatedBy.email },
      scope,
      revokeExistingGrants: false,
      props: {
        kind: "app",
        userId: target.id,
        email: target.email,
        projects: projectBound ? projects.map((project) => project.id) : null,
        deadline,
        impersonatedBy,
      } satisfies GrantProps,
    });
    // the records keep the grant's id, never the code, so either person can find and end it
    const grantId = grantIdOf(approved);
    const payload = {
      grantId,
      target: { userId: target.id, email: target.email },
      impersonatedBy,
      clientId: request.clientId,
      clientName: display.clientName,
      resource: request.resource === this.#addresses.mcp ? "mcp" : "api",
      scopes: scope,
      projects: projectBound ? projects.map((project) => project.id) : null,
      expiresAt: deadline,
    } satisfies Impersonation;
    const caller = { principal: impersonatedBy, grant: this.#grant.grantId };
    await Promise.all([
      appendPlatformFacts(
        env.ITERATE_CONTEXT,
        { account: target.id },
        { type: "events.iterate.com/account/impersonation-started", payload },
        caller,
      ),
      appendPlatformFacts(
        env.ITERATE_CONTEXT,
        { account: impersonatedBy.actor },
        { type: "events.iterate.com/account/impersonation-performed", payload },
        caller,
      ),
    ]);
    return approved;
  }

  /** Grant `client` the `projects` (null = every current and future one) and `scope`, and record
   *  the fact of the approval on the person's account context, stamped with them and the issuer
   *  grant they approved through. */
  async #complete(
    request: AuthRequest,
    client: ClientInfo | null,
    projects: string[] | null,
    scope: string[],
    // a platform admin's `admin` grant lives 12 hours: no refresh outlives its deadline
    lifetimeMs = (scope.includes("admin") ? 12 : 30 * 24) * 3600_000,
  ) {
    const env = this.#env;
    const display = clientDisplay(client, request.clientId);
    const approved = await oauthHelpers(env, this.#addresses).completeAuthorization({
      request,
      userId: this.#grant.userId,
      metadata: display,
      scope,
      revokeExistingGrants: false,
      props: {
        kind: "app",
        userId: this.#grant.userId,
        email: this.#grant.email,
        projects,
        deadline: Date.now() + lifetimeMs,
      } satisfies GrantProps,
    });
    publishPlatformFacts(
      {
        contextNamespace: env.ITERATE_CONTEXT,
        waitUntil: (promise) => this.#ctx.waitUntil(promise),
      },
      { account: this.#grant.userId },
      {
        type: "events.iterate.com/account/consent-approved",
        idempotencyKey: `account/consent-approved/${grantIdOf(approved)}`,
        payload: {
          clientId: request.clientId,
          clientName: display.clientName,
          projects,
          scopes: scope,
        } satisfies ConsentApproved,
      },
      {
        principal: { actor: this.#grant.userId, email: this.#grant.email },
        grant: this.#grant.grantId,
      },
    );
    return approved;
  }
}
