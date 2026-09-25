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
import { type ConsentApproved, type ImpersonationStarted } from "./account/contract.ts";
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
    }
  | {
      /** a platform admin's request to view the client as `target` (`act_as`, `#impersonate`) */
      kind: "impersonate";
      clientName: string;
      clientId: string;
      clientLogoUri?: string;
      clientDomain?: string;
      /** the admin, signed in */
      email: string;
      /** the person the client will act as */
      target: string;
      denyLocation: string;
    }
  | { kind: "redirect"; location: string }
  | { kind: "invalid"; description: string };

/** A platform-served project CIMD client can receive only that project's authority — its
 *  client.json on a project host (control-plane/edge.ts `projectHostOf`, as the edge admits one).
 *  `expected` are the ids the caller refuses without — approve's ticked projects, re-read past
 *  the isolate's access memo before one is left out (edge.ts `reachableProjects`). */
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
      const actAs = await this.#actAs(query);
      if (actAs && "error" in actAs) return { kind: "invalid", description: actAs.error };
      const testLinkApproval = actAs ? null : await this.#testLinkApproval(request, client);
      if (testLinkApproval) return { kind: "redirect", location: testLinkApproval.redirectTo };
      const display = clientDisplay(client, request.clientId);
      const denied = new URL(request.redirectUri);
      denied.searchParams.set("error", "access_denied");
      denied.searchParams.set("error_description", "The user declined access.");
      if (request.state) denied.searchParams.set("state", request.state);
      if (request.issuer) denied.searchParams.set("iss", request.issuer);
      if (actAs)
        return {
          kind: "impersonate",
          clientName: display.clientName,
          clientId: request.clientId,
          clientLogoUri: display.logoUri,
          clientDomain: display.clientDomain,
          email: this.#grant.email,
          target: actAs.target.email,
          denyLocation: denied.href,
        };
      // The page lists what the person holds NOW, read past this isolate's access memo: a project
      // just made (the page's New project form, served by whichever isolate) is listed at once.
      // The project list below reads the answer this read just memoized.
      const { organizations } = await new ControlPlane(env).accessibleTo(this.#grant.userId, true);
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
      };
    } catch (error) {
      return authorizationFailure(error);
    }
  }
  /** Approve: the projects ticked (`["*"]` = every current and future project) and, task-based
   *  consent, the scopes left ticked — `iterate` always, never one the request did not ask for; the
   *  grant and its tokens carry exactly that set (`session.info().scopes` tells the app). Without
   *  `scopes`, the request's whole set. */
  async approve(input: {
    query: string;
    projects: string[];
    scopes?: string[];
  }): Promise<{ redirectTo: string } | { error: string }> {
    const env = this.#env;
    const data = z
      .object({
        query: z.string(),
        projects: z.array(z.string()),
        scopes: z.array(z.string()).optional(),
      })
      .parse(input);
    try {
      const request = await this.#request(data.query);
      const client = await oauthHelpers(env, this.#addresses).lookupClient(request.clientId);
      const actAs = await this.#actAs(data.query);
      if (actAs)
        return "error" in actAs
          ? { error: actAs.error }
          : await this.#impersonate(request, client, actAs.target);
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

  /** The person an authorization's `act_as` names — a platform admin's "view this app as them", put
   *  there by the app's `/.auth/login?act_as=<email>` (iterate/app-server.ts) — or why it is
   *  refused: to anyone but an admin, and for an address nobody signed in as. Null when it names
   *  nobody. */
  async #actAs(query: string): Promise<{ target: UserRecord } | { error: string } | null> {
    const actAs = new URLSearchParams(query.replace(/^\?/, "")).get("act_as");
    if (!actAs) return null;
    if (!isAdmin(this.#env, this.#grant.email))
      return { error: "only a platform admin can view an app as someone else" };
    const target = await new ControlPlane(this.#env).getUser(actAs);
    if (!target) return { error: `nobody has signed in as ${actAs}` };
    return { target };
  }

  /** VIEW AN APP AS SOMEONE ELSE: a platform admin's approval of an authorization naming `act_as`.
   *  The client gets a grant of the PERSON VIEWED — stored under them, so it is in their Sessions —
   *  that reaches exactly what theirs would (every project of theirs, the scopes the client asked
   *  for but `admin`), with the admin beside them on every call it makes (`impersonatedBy`,
   *  oauth.ts). An hour, never refreshed past it; ended at once if the admin leaves `admins`. The
   *  person's own grants stay: `revokeExistingGrants`' default would sign them out. The start lands
   *  on their account, AWAITED, before the grant exists. */
  async #impersonate(request: AuthRequest, client: ClientInfo | null, target: UserRecord) {
    const env = this.#env;
    const impersonatedBy = { userId: this.#grant.userId, email: this.#grant.email };
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
    await appendPlatformFacts(
      env.ITERATE_CONTEXT,
      { account: target.id },
      {
        type: "events.iterate.com/account/impersonation-started",
        payload: {
          clientId: request.clientId,
          clientName: client?.clientName ?? request.clientId,
          scopes: scope,
          impersonatedBy,
          expiresAt: deadline,
        } satisfies ImpersonationStarted,
      },
      {
        principal: { actor: impersonatedBy.userId, email: impersonatedBy.email },
        grant: this.#grant.grantId,
      },
    );
    return oauthHelpers(env, this.#addresses).completeAuthorization({
      request,
      userId: target.id,
      metadata: clientDisplay(client, request.clientId),
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
  }

  /** Grant `client` the `projects` (null = every current and future one) and `scope`, and record
   *  the fact of the approval on the person's account context, stamped with them and the issuer
   *  grant they approved through. */
  async #complete(
    request: AuthRequest,
    client: ClientInfo | null,
    projects: string[] | null,
    scope: string[],
  ) {
    const env = this.#env;
    const approved = await oauthHelpers(env, this.#addresses).completeAuthorization({
      request,
      userId: this.#grant.userId,
      metadata: clientDisplay(client, request.clientId),
      scope,
      revokeExistingGrants: false,
      props: {
        kind: "app",
        userId: this.#grant.userId,
        email: this.#grant.email,
        projects,
        // a platform admin's `admin` grant lives 12 hours: no refresh outlives its deadline
        deadline: Date.now() + (scope.includes("admin") ? 12 : 30 * 24) * 3600_000,
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
        payload: {
          clientId: request.clientId,
          clientName: client?.clientName ?? request.clientId,
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

  /** ONE CLICK, NOT TWO: an issuer session a preview's test link started (issuer-session.ts
   *  `testLinkResponse`) approves, without the Allow page, a sibling app preview the link signed —
   *  an authorization that returns to the app's own `/.auth/callback` at one of the grant's
   *  `testLink.clients` (the redirect, not the client id: an app previewed on https is its CIMD
   *  client, one on localhost registers itself — iterate/app-session.ts — and either way the
   *  code can only land at that app) — once the test person's project (`pr<N>`, CI's seed) exists,
   *  with the scopes the app asked for and "All my projects": the person is a throwaway preview
   *  identity, and a grant narrowed to named projects could not create another in the Dash.
   *  Anything else (another app, no project yet, every other session) gets the page. */
  async #testLinkApproval(request: AuthRequest, client: ClientInfo | null) {
    const testLink = this.#grant.testLink;
    if (!testLink) return null;
    const returnsTo = new URL(request.redirectUri);
    if (returnsTo.pathname !== "/.auth/callback" || !testLink.clients.includes(returnsTo.origin))
      return null;
    const project = await new ControlPlane(this.#env).getProject(testLink.project);
    if (!project) return null;
    // `expected`: CI may have seeded the project on another isolate moments ago (the specs do)
    const { projects, projectBound } = await projectsForClient(
      this.#env,
      this.#addresses.platformOrigin,
      request.clientId,
      this.#grant.userId,
      [project.id],
    );
    // a project host's own client is bound to its one project: never "All my projects"
    if (projectBound || !projects.some((reachable) => reachable.id === project.id)) return null;
    return this.#complete(request, client, null, this.#grantable(request, projectBound));
  }
}
