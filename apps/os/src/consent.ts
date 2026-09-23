import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { RpcTarget } from "capnweb";
import { z } from "zod";
import { suggestOrganizationName } from "@iterate-com/shared/name-suggestions";
import { codedError } from "iterate/next/lib";
import {
  OAuthScope,
  OAuthScopeDescriptions,
  OAuthScopes,
  type ConsentScope,
} from "iterate/next/oauth-scopes";
import {
  customProjectHostOf,
  projectAddressOf,
  type IngressRouting,
} from "iterate/next/project-ingress";
import { type ConsentApproved } from "./account/contract.ts";
import type { Env } from "./env.ts";
import type { OrganizationRecord, ProjectRecord } from "./control-plane/catalog.ts";
import { ControlPlane } from "./control-plane/edge.ts";
import { appConfigOf, type PlatformAddresses } from "./app-config.ts";
import {
  authorizationOf,
  oauthHelpers,
  parseAuthorization,
  type AccessGrant,
  type GrantProps,
} from "./oauth.ts";
import { clientDisplay } from "./client-display.ts";
import { publishAccountFact } from "./session.ts";

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
       *  composes `<slug>.<hostname>` or `<origin>/<slug>/` from it; null when this deployment
       *  serves no project ingress */
      ingressRouting: IngressRouting;
      /** the onboarding step's first draft of an organization name: from the person's display name,
       *  else their email's company domain or local part */
      suggestedOrganizationName: string;
    }
  | { kind: "redirect"; location: string }
  | { kind: "invalid"; description: string };

/** A platform-served project CIMD client can receive only that project's authority — on a host
 *  under the project hostname base or on a project's custom apex (the same two hostname checks
 *  worker.ts admits a project host with). */
export async function projectsForClient(
  env: Env,
  platformOrigin: string,
  clientId: string,
  userId: string,
) {
  const controlPlane = new ControlPlane(env.CONTROL_PLANE);
  const projects = await controlPlane.reachableProjects({ userId });
  const url = URL.canParse(clientId) ? new URL(clientId) : null;
  const config = appConfigOf(env);
  const host =
    url?.pathname === "/.auth/client.json"
      ? (projectAddressOf(config.urls.ingressRouting, url, platformOrigin) ??
        (url.origin === platformOrigin || url.origin === config.urls.mcp
          ? null
          : customProjectHostOf(
              url.hostname,
              config.urls.temporaryCustomHostnames,
              config.urls.projectWildcard,
            )))
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
  constructor(env: Env, ctx: ExecutionContext, grant: AccessGrant, addresses: PlatformAddresses) {
    super();
    if (grant.kind !== "issuer")
      throw codedError("FORBIDDEN", "Sign in to iterate to approve access.");
    this.#env = env;
    this.#ctx = ctx;
    this.#grant = grant;
    this.#addresses = addresses;
  }
  async #request(query: unknown) {
    // Issuing a new grant must not spend the live transport's revocation grace.
    if (!(await authorizationOf(this.#env, this.#grant)))
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
      const display = clientDisplay(client, request.clientId);
      const denied = new URL(request.redirectUri);
      denied.searchParams.set("error", "access_denied");
      denied.searchParams.set("error_description", "The user declined access.");
      if (request.state) denied.searchParams.set("state", request.state);
      if (request.issuer) denied.searchParams.set("iss", request.issuer);
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
        scopes: request.scope.map((scope) => {
          const name = OAuthScope.parse(scope);
          return { name, ...OAuthScopeDescriptions[name] };
        }),
        orgs: (await new ControlPlane(env.CONTROL_PLANE).accessibleTo(this.#grant.userId))
          .organizations,
        ingressRouting: appConfigOf(env).urls.ingressRouting,
        suggestedOrganizationName: suggestOrganizationName({
          name: this.#grant.name,
          email: this.#grant.email,
        }),
        ...(await projectsForClient(
          env,
          this.#addresses.platformOrigin,
          request.clientId,
          this.#grant.userId,
        )),
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
      const { projects, projectBound } = await projectsForClient(
        env,
        this.#addresses.platformOrigin,
        request.clientId,
        this.#grant.userId,
      );
      const checked = new Set(data.projects);
      const granted = projects.filter((p) => checked.has(p.id)).map((p) => p.id);
      const allProjects = !projectBound && checked.has("*");
      if (!allProjects && !granted.length)
        return { error: "Choose at least one project you can access." };
      const scope = OAuthScopes.parse(
        (data.scopes || request.scope).filter(
          (candidate) =>
            request.scope.includes(candidate) && OAuthScope.safeParse(candidate).success,
        ),
      );
      const clientName = client?.clientName ?? request.clientId;
      const approved = await oauthHelpers(env, this.#addresses).completeAuthorization({
        request,
        userId: this.#grant.userId,
        metadata: clientDisplay(client, request.clientId),
        scope,
        revokeExistingGrants: false,
        props: {
          kind: "app",
          version: 2,
          userId: this.#grant.userId,
          email: this.#grant.email,
          projects: allProjects ? null : granted,
          deadline: Date.now() + 30 * 24 * 3600_000,
        } satisfies GrantProps,
      });
      // The fact of the approval, on the person's account context, stamped with them and the
      // issuer grant they approved through.
      publishAccountFact(
        {
          contextNamespace: env.ITERATE_CONTEXT,
          waitUntil: (promise) => this.#ctx.waitUntil(promise),
        },
        this.#grant.userId,
        {
          type: "events.iterate.com/account/consent-approved",
          payload: {
            clientId: request.clientId,
            clientName,
            projects: allProjects ? null : granted,
            scopes: scope,
          } satisfies ConsentApproved,
        },
        {
          principal: { actor: this.#grant.userId, email: this.#grant.email },
          grant: this.#grant.grantId,
        },
      );
      return approved;
    } catch (error) {
      const failure = authorizationFailure(error);
      return failure.kind === "redirect"
        ? { redirectTo: failure.location }
        : { error: failure.description };
    }
  }
}
